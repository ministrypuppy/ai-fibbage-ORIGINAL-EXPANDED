// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

let questions = [];
try {
    const rawData = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
    questions = JSON.parse(rawData);
} catch (err) {
    console.error("Error loading questions.json:", err);
}

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
            currentRound: 0,
            maxRounds: 6,
            phase: 'LOBBY',
            question: null,
            options: [],
            lies: {},
            votes: {},
            timer: null,
            timeLeft: 45,
            isPaused: false,
            pausedBy: null,
            usedQuestionIds: []
        };
        socket.join(roomCode);
        socket.emit('roomCreated', { roomCode });
    });

    socket.on('joinRoom', ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) {
            return socket.emit('errorMsg', 'Room not found!');
        }
        if (room.phase !== 'LOBBY') {
            return socket.emit('errorMsg', 'Game already started!');
        }

        room.players[socket.id] = { name: name || 'Player', score: 0 };
        socket.join(roomCode);
        socket.emit('joinedSuccess', { roomCode });
        io.to(roomCode).emit('updatePlayers', Object.values(room.players));
    });

    socket.on('togglePause', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (!room.isPaused) {
            room.isPaused = true;
            room.pausedBy = socket.id;
            if (room.timer) clearInterval(room.timer);
            io.to(roomCode).emit('pauseStateChanged', { paused: true, pausedBy: socket.id });
            io.to(roomCode).emit('hostStatusUpdate', 'Game Paused');
        } else {
            if (room.pausedBy === socket.id || socket.id === room.host) {
                room.isPaused = false;
                room.pausedBy = null;
                io.to(roomCode).emit('pauseStateChanged', { paused: false, pausedBy: null });
                startTimer(roomCode);
            }
        }
    });

    socket.on('startRound', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || socket.id !== room.host) return;

        room.currentRound++;
        if (room.currentRound > room.maxRounds) {
            room.currentRound = 1;
            Object.values(room.players).forEach(p => p.score = 0);
            room.usedQuestionIds = [];
        }

        room.phase = 'SUBMITTING';
        room.lies = {};
        room.votes = {};
        room.timeLeft = 45;
        room.isPaused = false;

        let available = questions.filter(q => !room.usedQuestionIds.includes(q.id));
        if (available.length === 0) {
            room.usedQuestionIds = [];
            available = questions;
        }
        const qObj = available[Math.floor(Math.random() * available.length)];
        room.usedQuestionIds.push(qObj.id);
        room.question = qObj;

        const multiplier = room.currentRound === 6 ? 3 : 1;
        io.to(roomCode).emit('newRound', {
            question: qObj.prompt,
            currentRound: room.currentRound,
            multiplier
        });

        startTimer(roomCode);
    });

    socket.on('submitLie', ({ roomCode, lie }) => {
        const room = rooms[roomCode];
        if (!room || room.phase !== 'SUBMITTING' || room.isPaused) return;

        room.lies[socket.id] = lie;

        const playerIds = Object.keys(room.players);
        if (Object.keys(room.lies).length === playerIds.length) {
            if (room.timer) clearInterval(room.timer);
            transitionToVoting(roomCode);
        }
    });

    socket.on('submitVote', ({ roomCode, optionIndex }) => {
        const room = rooms[roomCode];
        if (!room || room.phase !== 'VOTING' || room.isPaused) return;

        room.votes[socket.id] = optionIndex;

        const playerIds = Object.keys(room.players);
        if (Object.keys(room.votes).length === playerIds.length) {
            if (room.timer) clearInterval(room.timer);
            resolveRound(roomCode);
        }
    });

    socket.on('disconnect', () => {
        for (const code in rooms) {
            const room = rooms[code];
            if (room.players[socket.id]) {
                delete room.players[socket.id];
                io.to(code).emit('updatePlayers', Object.values(room.players));
            }
            if (room.host === socket.id) {
                io.to(code).emit('errorMsg', 'Host disconnected.');
                delete rooms[code];
            }
        }
    });
});

function startTimer(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (room.timer) clearInterval(room.timer);

    room.timer = setInterval(() => {
        if (room.isPaused) return;

        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', { timeLeft: room.timeLeft });

        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            if (room.phase === 'SUBMITTING') {
                Object.keys(room.players).forEach(pid => {
                    if (!room.lies[pid]) {
                        room.lies[pid] = room.question.decoy || room.question.decoys[0];
                    }
                });
                transitionToVoting(roomCode);
            } else if (room.phase === 'VOTING') {
                resolveRound(roomCode);
            }
        }
    }, 1000);
}

function transitionToVoting(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'VOTING';
    room.timeLeft = 45;

    let options = [{ text: room.question.answer, author: 'TRUTH' }];
    room.question.decoys.forEach(d => options.push({ text: d, author: 'DECOY' }));
    Object.entries(room.lies).forEach(([pid, text]) => {
        options.push({ text, author: pid });
    });

    options.sort(() => Math.random() - 0.5);
    room.options = options;

    io.to(roomCode).emit('startVoting', { options, currentRound: room.currentRound });
    startTimer(roomCode);
}

function resolveRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'REVEAL';
    const multiplier = room.currentRound === 6 ? 3 : 1;

    Object.entries(room.votes).forEach(([voterId, optIdx]) => {
        const selectedOpt = room.options[optIdx];
        if (selectedOpt.author === 'TRUTH') {
            room.players[voterId].score += (1000 * multiplier);
        } else if (selectedOpt.author !== 'DECOY') {
            if (room.players[selectedOpt.author]) {
                room.players[selectedOpt.author].score += (500 * multiplier);
            }
        }
    });

    const isGameOver = room.currentRound >= room.maxRounds;

    io.to(roomCode).emit('showReveal', {
        truth: room.question.answer,
        players: room.players,
        currentRound: room.currentRound,
        isGameOver
    });
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});