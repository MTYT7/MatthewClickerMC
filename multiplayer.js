/* Matthew Clicker V2 online preview.
 * Peer-to-peer lobby and host-authoritative click race. Scores are session-only.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = {
    peer: null, host: false, hostId: "", connection: null,
    connections: {}, players: {}, phase: "idle",
    startAt: 0, endAt: 0, timer: null, lastBroadcast: 0
  };
  const MAX_PLAYERS = 4;
  const ROUND_MS = 30000;

  function cleanName(value) {
    return String(value || "Player").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 16) || "Player";
  }
  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }
  function status(message, bad) {
    const el = $("onlineStatus");
    if (el) {
      el.textContent = message;
      el.style.border = bad ? "1px solid #fb7185" : "1px solid #76518b";
      el.style.color = bad ? "#fecdd3" : "#fff8e7";
    }
  }
  function setPhase(phase, message) {
    state.phase = phase;
    if ($("onlineRaceStatus")) $("onlineRaceStatus").textContent = message || "";
    if ($("onlineClickButton")) $("onlineClickButton").disabled = phase !== "racing";
    if ($("onlineReadyButton")) $("onlineReadyButton").disabled = phase === "countdown" || phase === "racing";
    if ($("onlineStartButton")) $("onlineStartButton").disabled = phase === "countdown" || phase === "racing";
  }
  function sortedPlayers() {
    return Object.values(state.players).sort((a, b) =>
      (b.clicks || 0) - (a.clicks || 0) || String(a.name).localeCompare(String(b.name))
    );
  }
  function render() {
    const list = $("onlinePlayers");
    const scores = $("onlineScoreboard");
    if (list) {
      list.innerHTML = Object.values(state.players).map(p =>
        '<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 10px;margin:5px 0;border-radius:8px;background:#21132d">' +
        '<span>' + escapeHTML(p.name) + (p.host ? ' <small>(host)</small>' : '') +
        (p.ready ? ' <small style="color:#86efac">✓ Ready</small>' : ' <small style="color:#d7c6e8">Not ready</small>') +
        '</span><strong>' + (p.clicks || 0).toLocaleString() + '</strong></div>'
      ).join("") || '<p style="color:#d7c6e8">No players connected yet.</p>';
    }
    if (scores) {
      scores.innerHTML = '<h3 style="color:#ffb703">🏆 Live scores</h3>' +
        sortedPlayers().map((p, i) =>
          '<div style="display:flex;gap:8px;justify-content:space-between;padding:7px 10px;border-radius:7px;margin:4px 0;background:#21132d">' +
          '<span>' + (i === 0 ? '👑 ' : (i + 1) + '. ') + escapeHTML(p.name) + '</span><strong>' +
          (p.clicks || 0).toLocaleString() + ' clicks</strong></div>'
        ).join("");
    }
    if ($("onlineStartButton")) $("onlineStartButton").style.display = state.host ? "inline-block" : "none";
    if ($("onlineReadyButton")) $("onlineReadyButton").style.display = state.host ? "none" : "inline-block";
  }
  function setInviteCode(code) {
    if ($("onlineRoomCodeDisplay")) $("onlineRoomCodeDisplay").textContent = code || "Waiting…";
  }
  function showRoom() {
    $("onlineJoinArea").style.display = "none";
    $("onlineRoomArea").style.display = "block";
  }
  function broadcast(message) {
    Object.values(state.connections).forEach(conn => {
      if (conn && conn.open) {
        try { conn.send(message); } catch (_) {}
      }
    });
  }
  function sendToHost(message) {
    if (state.connection && state.connection.open) {
      try { state.connection.send(message); } catch (_) {}
    }
  }
  function snapshot() {
    return {
      type: "state",
      phase: state.phase,
      startAt: state.startAt,
      endAt: state.endAt,
      players: Object.values(state.players).map(p => ({
        id: p.id, name: p.name, clicks: p.clicks || 0, ready: !!p.ready, host: !!p.host
      }))
    };
  }
  function publishState() {
    const packet = snapshot();
    broadcast(packet);
    render();
  }
  function acceptHostMessage(conn, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello") {
      if (Object.keys(state.players).length >= MAX_PLAYERS) {
        try { conn.send({ type: "error", message: "This room is full (maximum 4 players)." }); } catch (_) {}
        conn.close();
        return;
      }
      const name = cleanName(msg.name);
      state.players[conn.peer] = {
        id: conn.peer, name, clicks: 0, ready: false, host: false, conn
      };
      conn.send({ type: "welcome", hostId: state.peer.id, playerId: conn.peer });
      publishState();
      return;
    }
    const player = state.players[conn.peer];
    if (!player) return;
    if (msg.type === "ready" && state.phase === "lobby") {
      player.ready = !!msg.ready;
      publishState();
    } else if (msg.type === "click" && state.phase === "racing" &&
               Date.now() >= state.startAt && Date.now() < state.endAt) {
      const now = Date.now();
      if (!player.lastClickAt || now - player.lastClickAt >= 40) {
        player.lastClickAt = now;
        player.clicks = Math.min(1000000, (player.clicks || 0) + 1);
      }
    } else if (msg.type === "leave") {
      delete state.players[conn.peer];
      delete state.connections[conn.peer];
      publishState();
    }
  }
  function receiveGuestMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "welcome") {
      status("Connected! You're in the room. Get ready.", false);
    } else if (msg.type === "state") {
      state.phase = msg.phase || "lobby";
      state.startAt = msg.startAt || 0;
      state.endAt = msg.endAt || 0;
      state.players = {};
      (Array.isArray(msg.players) ? msg.players : []).forEach(p => { state.players[p.id] = p; });
      render();
      if (state.phase === "lobby") setPhase("lobby", "Waiting for the host to start a race.");
      else if (state.phase === "countdown") setPhase("countdown", "Get ready… race starting!");
      else if (state.phase === "racing") setPhase("racing", "GO! Click as fast as you can!");
      else if (state.phase === "done") setPhase("done", "Race finished! Check the scores above.");
      updateTimer();
    } else if (msg.type === "raceStart") {
      state.startAt = msg.startAt;
      state.endAt = msg.endAt;
      setPhase("countdown", "Get ready… race starting!");
    } else if (msg.type === "raceEnd") {
      setPhase("done", msg.winner ? msg.winner + " wins the race! 🎉" : "Race finished!");
    } else if (msg.type === "error") {
      status(msg.message || "The host reported a room error.", true);
    }
  }
  function updateTimer() {
    const timer = $("onlineTimeLeft");
    if (!timer) return;
    if (state.phase === "countdown") {
      timer.textContent = String(Math.max(0, Math.ceil((state.startAt - Date.now()) / 1000)));
    } else if (state.phase === "racing") {
      timer.textContent = String(Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000)));
    } else {
      timer.textContent = "30";
    }
  }
  function endRace() {
    if (!state.host || state.phase === "done") return;
    state.phase = "done";
    const winner = sortedPlayers()[0];
    const message = winner ? winner.name + " wins the race! 🎉" : "Race finished!";
    broadcast({ type: "raceEnd", winner: winner ? winner.name : "" });
    setPhase("done", message);
    if ($("onlineClickButton")) $("onlineClickButton").disabled = true;
    publishState();
  }
  function tick() {
    if (!state.host) { updateTimer(); return; }
    const now = Date.now();
    if (state.phase === "countdown" && now >= state.startAt) {
      setPhase("racing", "GO! Click as fast as you can!");
    }
    if (state.phase === "racing" && now >= state.endAt) {
      endRace();
      return;
    }
    if (now - state.lastBroadcast >= 250) {
      state.lastBroadcast = now;
      publishState();
    }
    updateTimer();
  }
  function startTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(tick, 100);
  }
  function resetConnection() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (state.peer) {
      try { state.peer.destroy(); } catch (_) {}
    }
    state.peer = null;
    state.host = false;
    state.hostId = "";
    state.connection = null;
    state.connections = {};
    state.players = {};
    state.phase = "idle";
    state.startAt = 0;
    state.endAt = 0;
  }
  function peerLibraryReady() {
    if (window.Peer) return Promise.resolve(true);
    return new Promise(resolve => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
      script.onload = () => resolve(!!window.Peer);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }
  async function makePeer() {
    status("Connecting to the online service…", false);
    const ready = await peerLibraryReady();
    if (!ready) {
      status("Could not load the online connection library. The network may block the service; try again later.", true);
      return null;
    }
    return new Promise(resolve => {
      const peer = new window.Peer();
      let settled = false;
      peer.on("open", id => {
        if (!settled) { settled = true; resolve({ peer, id }); }
      });
      peer.on("error", err => {
        status("Connection error: " + (err && err.type === "peer-unavailable" ? "room not found" : (err && err.type) || "could not connect") + ".", true);
        if (!settled) { settled = true; resolve(null); }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          status("The online service took too long to respond. Check your connection and try again.", true);
          resolve(null);
        }
      }, 15000);
    });
  }

  window.openOnlineLobby = function () {
    const ids = ["gameMenuHome", "tetrisScreen", "blockBlastScreen", "snakeScreen", "matthewRpgScreen"];
    ids.forEach(id => { const el = $(id); if (el) el.style.display = "none"; });
    $("onlineScreen").style.display = "block";
    $("gameMenuOverlay").style.display = "block";
    status("Choose Host Room or Join Room to connect.", false);
  };
  window.closeOnlineLobby = function () {
    resetConnection();
    $("onlineScreen").style.display = "none";
    if (typeof window.backToGameMenu === "function") window.backToGameMenu();
    else $("gameMenuHome").style.display = "block";
    $("onlineRoomArea").style.display = "none";
    $("onlineJoinArea").style.display = "none";
    setPhase("idle", "");
    status("Choose Host Room or Join Room to connect.", false);
  };
  window.mcOnlineShowJoin = function () {
    $("onlineJoinArea").style.display = "block";
    $("onlineRoomCode").focus();
  };
  window.mcOnlineHost = async function () {
    resetConnection();
    const result = await makePeer();
    if (!result) return;
    state.peer = result.peer;
    state.host = true;
    state.hostId = result.id;
    state.players[result.id] = {
      id: result.id, name: cleanName($("onlineName").value), clicks: 0, ready: true, host: true
    };
    state.phase = "lobby";
    setInviteCode(result.id);
    showRoom();
    status("Room created! Share the invite code with up to 3 friends.", false);
    setPhase("lobby", "Waiting for players. You can start when you're ready.");
    render();
    result.peer.on("connection", conn => {
      if (Object.keys(state.players).length >= MAX_PLAYERS) {
        conn.on("open", () => { try { conn.send({ type: "error", message: "This room is full (maximum 4 players)." }); } catch (_) {} conn.close(); });
        return;
      }
      state.connections[conn.peer] = conn;
      conn.on("data", msg => acceptHostMessage(conn, msg));
      conn.on("open", () => {
        try { conn.send({ type: "welcome", hostId: state.peer.id, playerId: conn.peer }); } catch (_) {}
        publishState();
      });
      conn.on("close", () => {
        delete state.connections[conn.peer];
        delete state.players[conn.peer];
        publishState();
      });
      conn.on("error", () => {
        delete state.connections[conn.peer];
        delete state.players[conn.peer];
        publishState();
      });
    });
    startTimer();
  };
  window.mcOnlineJoin = async function () {
    const hostId = String($("onlineRoomCode").value || "").trim();
    if (!hostId) { status("Enter the host's invite code first.", true); return; }
    resetConnection();
    const result = await makePeer();
    if (!result) return;
    state.peer = result.peer;
    state.host = false;
    state.hostId = hostId;
    state.phase = "lobby";
    const conn = result.peer.connect(hostId, { reliable: true });
    state.connection = conn;
    conn.on("open", () => {
      conn.send({ type: "hello", name: cleanName($("onlineName").value) });
      showRoom();
      setInviteCode(hostId);
      status("Connected to host. Waiting for the lobby to sync…", false);
    });
    conn.on("data", receiveGuestMessage);
    conn.on("close", () => {
      status("Disconnected from the host.", true);
      setPhase("idle", "Connection lost. Return to the menu and try again.");
    });
    conn.on("error", () => status("Couldn't connect to that room. Check the invite code and try again.", true));
    result.peer.on("error", err => {
      if (err && err.type === "peer-unavailable") status("Room not found. Check the invite code and ask the host to reopen their room.", true);
    });
    startTimer();
  };
  window.mcOnlineCopyCode = async function () {
    const code = $("onlineRoomCodeDisplay").textContent;
    try {
      await navigator.clipboard.writeText(code);
      status("Invite code copied. Send it to your friends.", false);
    } catch (_) {
      window.prompt("Copy this room invite code:", code);
    }
  };
  window.mcOnlineReady = function () {
    if (state.host || !state.connection) return;
    const me = state.players[state.peer && state.peer.id];
    const next = !(me && me.ready);
    sendToHost({ type: "ready", ready: next });
    status(next ? "You're marked ready." : "You're not ready yet.", false);
  };
  window.mcOnlineStart = function () {
    if (!state.host || state.phase === "racing" || state.phase === "countdown") return;
    const startAt = Date.now() + 3000;
    state.startAt = startAt;
    state.endAt = startAt + ROUND_MS;
    Object.values(state.players).forEach(p => { p.clicks = 0; });
    state.phase = "countdown";
    broadcast({ type: "raceStart", startAt, endAt: state.endAt });
    setPhase("countdown", "Get ready… race starts in 3 seconds!");
    publishState();
    startTimer();
  };
  window.mcOnlineClick = function () {
    if (state.phase !== "racing") return;
    if (state.host) {
      if (Date.now() >= state.startAt && Date.now() < state.endAt && state.peer) {
        const me = state.players[state.peer.id];
        if (me) me.clicks = Math.min(1000000, (me.clicks || 0) + 1);
        render();
      }
    } else {
      sendToHost({ type: "click" });
    }
  };
  window.addEventListener("beforeunload", () => {
    try { sendToHost({ type: "leave" }); } catch (_) {}
    resetConnection();
  });
})();
