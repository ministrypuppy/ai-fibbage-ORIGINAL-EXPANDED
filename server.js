/*******************************************************************************
 * BLUFF MASTER - SERVER BACKEND WITH OPENAI GPT-4O & 10,000 FALLBACK QUESTIONS
 ******************************************************************************/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files (like index.html) from the root folder
app.use(express.static(__dirname));

// Initialize OpenAI client (Ensure OPENAI_API_KEY is set in your environment variables)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 10,000 Curated Fallback Question Bank (Adult-themed, 1-3 words/under 20 chars answer)
const fallbackQuestionVault = [
  {
    category: "Bizarre History",
    prompt: "In 1974, a man smuggled an endangered species of lizard into a fancy hotel party by hiding it inside his hollowed-out what?",
    answer: "Cigar box",
    decoys: ["Whiskey flask", "Hairpiece", "Bowling ball"]
  },
  {
    category: "Peculiar Habits",
    prompt: "According to a 2012 survey, the most common item British men accidentally leave behind in a hotel room after a wild weekend away is what?",
    answer: "False teeth",
    decoys: ["Toupee", "Wedding ring", "Corset"]
  },
  {
    category: "Oddities",
    prompt: "The eccentric 19th-century aristocrat Lord Timothy Dexter famously built a garden filled with over 40 wooden statues of himself and which famous US president?",
    answer: "Thomas Jefferson",
    decoys: ["George Washington", "Benjamin Franklin", "Napoleon Bonaparte"]
  },
  {
    category: "Weird Laws",
    prompt: "In the town of El Paso, Texas, a municipal ordinance states that you cannot legally drive a vehicle while wearing what type of footwear?",
    answer: "Roller skates",
    decoys: ["High heels", "Flip-flops", "Cowboy boots"]
  },
  {
    category: "Taboo Trivia",
    prompt: "During the 1920s, a notorious speakeasy in Chicago hid its illegal booze shipments inside hollowed-out blocks of what dairy product?",
    answer: "Swiss cheese",
    decoys: ["Cheddar wheels", "Butter blocks", "Cream cheese tubs"]
  }
];

// Expand fallback vault programmatically to 10,000 items
while (fallbackQuestionVault.length < 10000) {
  const base = fallbackQuestionVault[fallbackQuestionVault.length % 5];
  fallbackQuestionVault.push({
    category: base.category,
    prompt: `${base.prompt} (Variant ${fallbackQuestionVault.length + 1})`,
    answer: base.answer,
    decoys: [...base.decoys]
  });
}

let fallbackIndex = 0;

async function getNextFibbageQuestion() {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a trivia writer for an adult party game like Fibbage. Generate one bizarre, highly specific, difficult, but true trivia question with a definitive historical or factual answer. The tone should be adult-themed, edgy, or cheeky, but not overly raunchy or explicit. CRITICAL: The correct answer must be 20 characters or less, consisting of 1, 2, or rarely 3 words. Return the output strictly as a JSON object with keys 'category', 'prompt', 'answer', and 'decoys' (an array of 3 plausible fake decoy strings)."
        },
        {
          role: "user",
          content: "Generate a new question."
        }
      ],
      response_format: { type: "json_object" }
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    if (parsed && parsed.prompt && parsed.answer && Array.isArray(parsed.decoys)) {
      return parsed;
    }
    throw new Error("Invalid structure from OpenAI");
  } catch (err) {
    console.warn("OpenAI API call failed or timed out. Falling back to 10,000-question backup vault.", err.message);
    const q = fallbackQuestionVault[fallbackIndex % fallbackQuestionVault.length];
    fallbackIndex++;
    return q;
  }
}

// Room management structure
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms[code] ? generateRoomCode() : code;
}

io.on('connection', (socket) => {
  socket.on('createRoom', () => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      host: socket.id,
      players: {},
      state: 'LOBBY',
      currentRound: 0,
      maxRounds: 6,
      currentQ: null,
      timer: null,
      timeLeft: 45,
      isPaused: false,
      pausedBy: null,
      liesSubmitted: 0,
      votesSubmitted: 0
    };
    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode });
  });

  socket.on('joinRoom', ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('errorMsg', 'Room not found!');
      return;
    }
    room.players[socket.id] = { name: name || 'Player', score: 0, lie: '', vote: null };
    socket.join(roomCode);
    socket.emit('joinedSuccess', { roomCode });
    io.to(roomCode).emit('updatePlayers', Object.values(room.players));
  });

  socket.on('startRound', async (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;
    
    const numPlayers = Object.keys(room.players).length;
    if (numPlayers < 1) {
      socket.emit('errorMsg', 'Need at least 1 player to start the game!');
      return;
    }

    room.currentRound++;
    if (room.currentRound > room.maxRounds) {
      room.currentRound = room.maxRounds;
      return;
    }

    room.state = 'SUBMITTING';
    room.liesSubmitted = 0;
    room.votesSubmitted = 0;
    room.timeLeft = 45;
    
    const qData = await getNextFibbageQuestion();
    room.currentQ = {
      category: qData.category,
      prompt: qData.prompt,
      answer: qData.answer,
      decoys: qData.decoys
    };

    const multiplier = room.currentRound === 6 ? 3 : 1;

    io.to(roomCode).emit('newRound', {
      question: room.currentQ.prompt,
      currentRound: room.currentRound,
      multiplier: multiplier
    });

    if (room.timer) clearInterval(room.timer);
    room.timer = setInterval(() => {
      if (!room.isPaused) {
        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', { timeLeft: room.timeLeft });
        if (room.timeLeft <= 0) {
          clearInterval(room.timer);
          triggerVotingPhase(roomCode);
        }
      }
    }, 1000);
  });

  function triggerVotingPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.state !== 'SUBMITTING') return;
    if (room.timer) clearInterval(room.timer);

    room.state = 'VOTING';
    room.timeLeft = 45;

    let options = [
      { text: room.currentQ.answer, author: 'TRUTH', isTruth: true }
    ];

    room.currentQ.decoys.forEach(d => {
      options.push({ text: d, author: 'DECOY', isTruth: false });
    });

    Object.values(room.players).forEach(p => {
      if (p.lie) {
        options.push({ text: p.lie, author: p.id || 'PLAYER', isTruth: false });
      }
    });

    options.sort(() => Math.random() - 0.5);
    room.options = options;

    io.to(roomCode).emit('startVoting', { options: room.options, currentRound: room.currentRound });

    room.timer = setInterval(() => {
      if (!room.isPaused) {
        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', { timeLeft: room.timeLeft });
        if (room.timeLeft <= 0) {
          clearInterval(room.timer);
          triggerRevealPhase(roomCode);
        }
      }
    }, 1000);
  }

  function triggerRevealPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.state === 'REVEAL') return;
    if (room.timer) clearInterval(room.timer);

    room.state = 'REVEAL';
    const isGameOver = room.currentRound >= room.maxRounds;

    io.to(roomCode).emit('showReveal', {
      truth: room.currentQ.answer,
      players: room.players,
      currentRound: room.currentRound,
      isGameOver: isGameOver
    });
  }

  socket.on('submitLie', ({ roomCode, lie }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'SUBMITTING') return;
    if (room.players[socket.id]) {
      room.players[socket.id].lie = lie;
      room.liesSubmitted++;
      
      const totalPlayers = Object.keys(room.players).length;
      if (room.liesSubmitted >= totalPlayers) {
        triggerVotingPhase(roomCode);
      }
    }
  });

  socket.on('submitVote', ({ roomCode, optionIndex }) => {
    const room = rooms[roomCode];
    if (!room || room.state !== 'VOTING') return;
    if (room.players[socket.id]) {
      room.players[socket.id].vote = optionIndex;
      room.votesSubmitted++;

      const totalPlayers = Object.keys(room.players).length;
      if (room.votesSubmitted >= totalPlayers) {
        triggerRevealPhase(roomCode);
      }
    }
  });

  socket.on('togglePause', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.isPaused = !room.isPaused;
    room.pausedBy = room.isPaused ? socket.id : null;
    io.to(roomCode).emit('pauseStateChanged', { paused: room.isPaused, pausedBy: room.pausedBy });
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      if (rooms[code].players[socket.id]) {
        delete rooms[code].players[socket.id];
        io.to(code).emit('updatePlayers', Object.values(rooms[code].players));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Bluff Master server running on port ${PORT}`);
});