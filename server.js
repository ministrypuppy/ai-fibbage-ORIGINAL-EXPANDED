const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), {
    headers: { 'Content-Type': 'text/html' }
  });
});

const rooms = {};

const fallbackLies = [
  "Accidentally joining a cult",
  "Selling fake bath salts",
  "Getting banned from a buffet",
  "Challenging a bear to arm wrestling",
  "Stealing a police horse while drunk",
  "Wearing a fake mustache to a job interview",
  "Smuggling exotic ferrets in pants",
  "Faking a twin to skip work"
];

const partyTrivia = [
  {
    question: "In 2012, a man in New Zealand was arrested after calling the emergency services to complain about ____.",
    answer: "bad weed quality",
    houseLies: ["his prostitute being late", "cold McDonald's fries", "a missing cat"]
  },
  {
    question: "Before inventing the telephone, Alexander Graham Bell suggested answering phone calls with the phrase ____.",
    answer: "Ahoy",
    houseLies: ["What's crackin'", "Howdy pardner", "Speak human"]
  },
  {
    question: "In 2017, a UK man legally changed his name to ____ after losing a drunk bet.",
    answer: "Bacon Double Cheeseburger",
    houseLies: ["Captain Underpants", "Lord Voldemort", "Sir Mix-A-Lot"]
  },
  {
    question: "In 1998, a French court ruled that employees could not be fired for ____ during work hours.",
    answer: "having a brief affair",
    houseLies: ["drinking wine", "napping under desks", "swearing at bosses"]
  },
  {
    question: "To discourage drunk driving, a bar in Texas instituted a policy where patrons had to pass a ____ test before leaving.",
    answer: "unicycle riding",
    houseLies: ["tongue twister", "line dancing", "origami"]
  }
];

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function fetchAIQuestion() {
  if (Math.random() > 0.5) {
    return partyTrivia[Math.floor(Math.random() * partyTrivia.length)];
  }

  try {
    const categories = [9, 26, 27];
    const cat = categories[Math.floor(Math.random() * categories.length)];
    const res = await fetch(`https://opentdb.com/api.php?amount=1&category=${cat}&type=multiple`);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      const q = data.results[0];
      const clean = (str) => str.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&deg;/g, '°');
      return {
        question: clean(q.question),
        answer: clean(q.correct_answer),
        houseLies: q.incorrect_answers.map(clean)
      };
    }
  } catch (err) {}

  return partyTrivia[Math.floor(Math.random() * partyTrivia.length)];
}

function clearRoomTimers(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
  if (room.autoNextTimer) {
    clearTimeout(room.autoNextTimer);
    room.autoNextTimer = null;
  }
}

function startPhaseTimer(room, duration, cleanCode, onTick, onExpire) {
  clearRoomTimers(room);
  room.timeLeft = duration;
  onTick(room.timeLeft);

  room.timer = setInterval(() => {
    if (room.isPaused) return;
    room.timeLeft--;
    onTick(room.timeLeft);
    if (room.timeLeft <= 0) {
      clearRoomTimers(room);
      onExpire();
    }
  }, 1000);
}

function getMultiplier(round) {
  if (round <= 3) return 1;
  if (round <= 5) return 2;
  return 3;
}

function triggerVotingPhase(room, cleanCode) {
  clearRoomTimers(room);
  room.state = 'VOTING';
  
  Object.entries(room.players).forEach(([id, p]) => {
    if (!p.currentLie || p.currentLie.length === 0) {
      const randomLie = fallbackLies[Math.floor(Math.random() * fallbackLies.length)];
      p.currentLie = randomLie;
    }
  });

  const rawOptions = [{ text: room.currentQuestion.answer, isCorrect: true, author: 'TRUTH' }];
  Object.entries(room.players).forEach(([id, p]) => {
    if (p.currentLie.length > 0) {
      rawOptions.push({ text: p.currentLie, isCorrect: false, author: id });
    }
  });

  if (room.currentQuestion.houseLies && room.currentQuestion.houseLies[0]) {
    rawOptions.push({ text: room.currentQuestion.houseLies[0], isCorrect: false, author: 'HOUSE' });
  }

  room.options = rawOptions.sort(() => Math.random() - 0.5);

  io.to(cleanCode).emit('startVoting', {
    question: room.currentQuestion.question,
    options: room.options,
    multiplier: room.multiplier,
    currentRound: room.currentRound
  });

  startPhaseTimer(
    room,
    45,
    cleanCode,
    (timeLeft) => io.to(cleanCode).emit('timerUpdate', { timeLeft, phase: 'VOTING' }),
    () => triggerRevealPhase(room, cleanCode)
  );
}

function triggerRevealPhase(room, cleanCode) {
  clearRoomTimers(room);
  room.state = 'REVEAL';
  
  const baseTruth = 1000 * room.multiplier;
  const baseFooled = 500 * room.multiplier;

  Object.entries(room.votes).forEach(([voterId, chosenIdx]) => {
    const chosenOption = room.options[chosenIdx];
    if (!chosenOption) return;
    if (chosenOption.isCorrect) {
      room.players[voterId].score += baseTruth;
    } else if (chosenOption.author !== 'HOUSE' && chosenOption.author !== voterId) {
      if (room.players[chosenOption.author]) {
        room.players[chosenOption.author].score += baseFooled;
      }
    }
  });

  io.to(cleanCode).emit('showReveal', {
    truth: room.currentQuestion.answer,
    options: room.options,
    votes: room.votes,
    players: room.players,
    currentRound: room.currentRound,
    multiplier: room.multiplier,
    isGameOver: room.currentRound >= 6
  });

  // 10-second automatic transition timer
  room.autoNextTimer = setTimeout(() => {
    if (room.state === 'REVEML' || room.state === 'REVEAL') {
      startRoundForRoom(cleanCode, room);
    }
  }, 10000);
}

async function startRoundForRoom(cleanCode, room) {
  clearRoomTimers(room);
  if (room.currentRound >= 6) {
    room.currentRound = 0;
    Object.values(room.players).forEach(p => p.score = 0);
  }

  room.currentRound += 1;
  room.multiplier = getMultiplier(room.currentRound);
  room.state = 'SUBMITTING';
  room.votes = {};
  Object.keys(room.players).forEach(id => {
    room.players[id].currentLie = '';
  });

  const qData = await fetchAIQuestion();
  room.currentQuestion = qData;

  io.to(cleanCode).emit('newRound', { 
    question: qData.question, 
    currentRound: room.currentRound,
    multiplier: room.multiplier 
  });

  startPhaseTimer(
    room,
    45,
    cleanCode,
    (timeLeft) => io.to(cleanCode).emit('timerUpdate', { timeLeft, phase: 'SUBMITTING' }),
    () => triggerVotingPhase(room, cleanCode)
  );
}

io.on('connection', (socket) => {
  socket.on('createRoom', () => {
    let code = generateRoomCode();
    while (rooms[code]) {
      code = generateRoomCode();
    }
    rooms[code] = {
      hostId: socket.id,
      players: {},
      state: 'LOBBY',
      currentRound: 0,
      multiplier: 1,
      currentQuestion: null,
      options: [],
      votes: {},
      timer: null,
      timeLeft: 0,
      isPaused: false,
      autoNextTimer: null
    };
    socket.join(code);
    socket.emit('roomCreated', { roomCode: code });
  });

  socket.on('joinRoom', ({ roomCode, name }) => {
    const cleanCode = roomCode ? roomCode.trim().toUpperCase() : '';
    const room = rooms[cleanCode];
    if (!room) return socket.emit('errorMsg', 'Room not found.');
    if (room.state !== 'LOBBY') return socket.emit('errorMsg', 'Game already in progress.');

    socket.join(cleanCode);
    room.players[socket.id] = { name, score: 0, currentLie: '' };
    socket.emit('joinedSuccess', { roomCode: cleanCode, name });
    io.to(room.hostId).emit('updatePlayers', Object.values(room.players));
  });

  socket.on('togglePause', ({ roomCode }) => {
    const cleanCode = roomCode ? roomCode.trim().toUpperCase() : '';
    const room = rooms[cleanCode];
    if (!room) return;
    room.isPaused = !room.isPaused;
    io.to(cleanCode).emit('pauseStateChanged', { paused: room.isPaused });
  });

  socket.on('startRound', async (roomCode) => {
    const cleanCode = roomCode ? roomCode.trim().toUpperCase() : '';
    const room = rooms[cleanCode];
    if (!room) return;
    await startRoundForRoom(cleanCode, room);
  });

  socket.on('submitLie', ({ roomCode, lie }) => {
    const cleanCode = roomCode ? roomCode.trim().toUpperCase() : '';
    const room = rooms[cleanCode];
    if (!room || room.isPaused || !room.players[socket.id] || room.state !== 'SUBMITTING') return;

    room.players[socket.id].currentLie = lie.trim();

    const playersArray = Object.values(room.players);
    const submittedCount = playersArray.filter(p => p.currentLie.length > 0).length;

    io.to(room.hostId).emit('hostStatusUpdate', `Submitted: ${submittedCount} / ${playersArray.length}`);

    if (submittedCount === playersArray.length && playersArray.length > 0) {
      triggerVotingPhase(room, cleanCode);
    }
  });

  socket.on('submitVote', ({ roomCode, optionIndex }) => {
    const cleanCode = roomCode ? roomCode.trim().toUpperCase() : '';
    const room = rooms[cleanCode];
    if (!room || room.isPaused || !room.players[socket.id] || room.state !== 'VOTING') return;

    room.votes[socket.id] = optionIndex;
    const playerIds = Object.keys(room.players);

    if (Object.keys(room.votes).length === playerIds.length && playerIds.length > 0) {
      triggerRevealPhase(room, cleanCode);
    }
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(code => {
      const room = rooms[code];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(room.hostId).emit('updatePlayers', Object.values(room.players));
      }
    });
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));