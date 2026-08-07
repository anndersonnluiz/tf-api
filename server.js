const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createDeck, shuffle } = require('./deck');

const cardValuesHierarchy = ['4', '5', '6', '7', '10', '11', '12', 'A', '2', '3'];
const suitHierarchy = ['ouros', 'espadas', 'copas', 'paus'];

const PORT = Number(process.env.PORT) || 3000;
const NEXT_ROUND_DELAY_MS = 7000;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (allowedOrigins.includes('*')) {
    return true;
  }

  return !origin || allowedOrigins.includes(origin);
}

const app = express();
app.use(cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS'));
  }
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origin not allowed by CORS'));
    },
    methods: ['GET', 'POST']
  }
});

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';

  for (let i = 0; i < 4; i += 1) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return code;
}

function calculateGuaranteedTricks(players) {
  const activePlayers = players.filter((player) => !player.eliminated);

  activePlayers.forEach((player) => {
    if (activePlayers.length === 1) {
      player.guaranteedTricks = player.hand.length;
      return;
    }

    const maxOtherHand = Math.max(
      ...activePlayers
        .filter((otherPlayer) => otherPlayer !== player)
        .map((otherPlayer) => otherPlayer.hand.length)
    );

    player.guaranteedTricks = Math.max(0, player.hand.length - maxOtherHand);
  });
}

function calculateNaturalTricks(players) {
  const activePlayers = players.filter((player) => !player.eliminated);

  activePlayers.forEach((player) => {
    if (activePlayers.length === 1) {
      player.tricksWon = (player.tricksWon || 0) + player.hand.length;
      return;
    }

    const maxOtherHand = Math.max(
      ...activePlayers
        .filter((otherPlayer) => otherPlayer !== player)
        .map((otherPlayer) => otherPlayer.hand.length)
    );

    const naturalTricks = Math.max(0, player.hand.length - maxOtherHand);
    player.tricksWon = (player.tricksWon || 0) + naturalTricks;
  });
}

function buildPublicPlayerStates(room) {
  const currentPlayer = room.players[room.currentTurnIndex];

  return room.players.map((player) => ({
    name: player.name,
    lives: player.lives !== undefined ? player.lives : 5,
    tricksWon: player.tricksWon || 0,
    bet: player.bet,
    hasBet: player.bet !== undefined && player.bet !== null,
    cardsInHand: player.hand ? player.hand.length : 0,
    eliminated: !!player.eliminated,
    isCurrentTurn: currentPlayer ? currentPlayer.socketId === player.socketId : false
  }));
}

function emitRoomUpdated(roomCode, room) {
  io.to(roomCode).emit('room_updated', {
    players: room.players,
    playerStates: buildPublicPlayerStates(room)
  });
}

function emitTurnUpdate(roomCode, room, currentPlayerId) {
  io.to(roomCode).emit('turn_update', {
    currentPlayerId,
    playerStates: buildPublicPlayerStates(room)
  });
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create_room', (data) => {
    const { playerName, isPrivate } = data;

    let roomCode = generateRoomCode();
    while (rooms[roomCode]) {
      roomCode = generateRoomCode();
    }

    rooms[roomCode] = {
      id: roomCode,
      players: [{ socketId: socket.id, name: playerName }],
      status: 'WAITING',
      isPrivate: !!isPrivate,
      deck: [],
      round: 0
    };

    socket.join(roomCode);
    console.log(`[CREATE] Room ${roomCode} created by ${playerName} (Private: ${!!isPrivate})`);

    socket.emit('room_created', { roomCode, room: rooms[roomCode] });
    emitRoomUpdated(roomCode, rooms[roomCode]);
  });

  socket.on('join_room', (data) => {
    const { playerName, roomCode } = data;
    const room = rooms[roomCode];

    if (!room) {
      socket.emit('error', { message: 'Sala não encontrada.' });
      return;
    }

    if (room.players.length >= 5) {
      socket.emit('error', { message: 'A sala está cheia.' });
      return;
    }

    room.players.push({ socketId: socket.id, name: playerName });
    socket.join(roomCode);
    console.log(`[JOIN] ${playerName} joined room ${roomCode}`);

    io.to(roomCode).emit('room_joined', { roomCode, room });
    emitRoomUpdated(roomCode, room);
  });

  socket.on('quick_match', (data) => {
    const { playerName } = data;
    let joined = false;

    Object.keys(rooms).forEach((code) => {
      if (joined) {
        return;
      }

      const room = rooms[code];
      if (!room.isPrivate && room.status === 'WAITING' && room.players.length < 5) {
        room.players.push({ socketId: socket.id, name: playerName });
        socket.join(code);
        console.log(`[QUICK MATCH] ${playerName} joined room ${code}`);
        io.to(code).emit('room_joined', { roomCode: code, room });
        emitRoomUpdated(code, room);
        joined = true;
      }
    });

    if (!joined) {
      let roomCode = generateRoomCode();
      while (rooms[roomCode]) {
        roomCode = generateRoomCode();
      }

      rooms[roomCode] = {
        id: roomCode,
        players: [{ socketId: socket.id, name: playerName }],
        status: 'WAITING',
        isPrivate: false,
        deck: [],
        round: 0
      };

      socket.join(roomCode);
      console.log(`[QUICK MATCH] Room ${roomCode} created for ${playerName}`);
      socket.emit('room_created', { roomCode, room: rooms[roomCode] });
      emitRoomUpdated(roomCode, rooms[roomCode]);
    }
  });

  socket.on('start_game', (data) => {
    const { roomCode } = data;
    const room = rooms[roomCode];

    if (!room || room.status !== 'WAITING') {
      return;
    }

    if (room.players.length < 2) {
      socket.emit('error', { message: 'A partida precisa de pelo menos 2 jogadores para iniciar.' });
      return;
    }

    room.deck = shuffle(createDeck());
    room.status = 'BETTING';
    room.currentTurnIndex = 0;
    room.trickStarterIndex = 0;
    room.tableCards = [];
    room.roundHistory = [];
    room.cardsPlayedInRound = 0;
    room.cardsPerPlayer = 0;
    room.round += 1;

    room.players.forEach((player) => {
      player.hand = [];
      player.tricksWon = 0;
      player.bet = null;
      player.lives = player.lives !== undefined ? player.lives : 5;

      const cardCount = player.lives;
      for (let i = 0; i < cardCount; i += 1) {
        player.hand.push(room.deck.pop());
      }
    });

    calculateGuaranteedTricks(room.players);

    room.players.forEach((player) => {
      io.to(player.socketId).emit('hand_dealt', { hand: player.hand, lives: player.lives });
    });

    room.currentTrump = room.deck.pop();
    room.cardsPerPlayer = room.players.filter((player) => !player.eliminated)[0]?.hand.length || 5;
    room.playableTricksThisRound = Math.min(
      ...room.players.filter((player) => !player.eliminated).map((player) => player.hand.length)
    );

    io.to(roomCode).emit('round_started', {
      round: room.round,
      trump: room.currentTrump,
      cardsPerPlayer: room.cardsPerPlayer,
      playerStates: buildPublicPlayerStates(room)
    });
    emitTurnUpdate(roomCode, room, room.players[room.currentTurnIndex].socketId);

    console.log(`[START] Game started in room ${roomCode}. Round: ${room.round}`);
  });

  socket.on('make_bet', (data) => {
    const { roomCode, bet } = data;
    const room = rooms[roomCode];

    if (!room || room.status !== 'BETTING') {
      return;
    }

    const currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || socket.id !== currentPlayer.socketId) {
      socket.emit('bet_error', { message: 'Aguarde a sua vez de apostar.' });
      return;
    }

    if (bet < (currentPlayer.guaranteedTricks || 0)) {
      socket.emit('bet_error', {
        message: `Você é obrigado a apostar pelo menos as suas vazas garantidas (${currentPlayer.guaranteedTricks})!`
      });
      return;
    }

    const activePlayers = room.players.filter((player) => !player.eliminated);
    const isLastBettor = room.currentTurnIndex === activePlayers.length - 1;
    if (isLastBettor) {
      let sum = 0;
      for (let i = 0; i < activePlayers.length - 1; i += 1) {
        sum += activePlayers[i].bet || 0;
      }

      if (sum + bet === room.cardsPerPlayer) {
        socket.emit('bet_error', { message: 'A soma das apostas não pode empatar com o número de cartas!' });
        return;
      }
    }

    currentPlayer.bet = bet;
    room.currentTurnIndex += 1;

    if (room.currentTurnIndex >= room.players.length) {
      room.status = 'PLAYING';
      room.currentTurnIndex = room.trickStarterIndex || 0;

      io.to(roomCode).emit('playing_started', {
        message: 'As apostas terminaram! A fase de jogo começou.',
        playerStates: buildPublicPlayerStates(room)
      });
      emitTurnUpdate(roomCode, room, room.players[room.currentTurnIndex].socketId);
      return;
    }

    emitTurnUpdate(roomCode, room, room.players[room.currentTurnIndex].socketId);
  });

  socket.on('play_card', (data) => {
    const { roomCode, card } = data;
    const room = rooms[roomCode];

    if (!room || room.status !== 'PLAYING') {
      return;
    }

    const currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || socket.id !== currentPlayer.socketId) {
      socket.emit('error', { message: 'Aguarde sua vez de jogar.' });
      return;
    }

    if (room.tableCards.length === 0) {
      room.trickStarterIndex = room.currentTurnIndex;
    }

    const cardIndex = currentPlayer.hand.findIndex(
      (currentCard) => currentCard.value === card.value && currentCard.suit === card.suit
    );

    if (cardIndex === -1) {
      return;
    }

    currentPlayer.hand.splice(cardIndex, 1);
    room.tableCards.push({
      playerIndex: room.currentTurnIndex,
      playerName: currentPlayer.name,
      card
    });

    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;

    io.to(roomCode).emit('table_updated', {
      tableCards: room.tableCards,
      playerStates: buildPublicPlayerStates(room)
    });
    emitTurnUpdate(roomCode, room, room.players[room.currentTurnIndex].socketId);

    if (room.tableCards.length !== room.players.length) {
      return;
    }

    room.status = 'RESOLVING_TRICK';

    setTimeout(() => {
      let winnerName = '';
      let isTie = false;
      let winnerIndex = -1;
      let bestCard = null;

      const trumpValue = room.currentTrump.value;
      const playedTrumps = room.tableCards.filter((tableCard) => tableCard.card.value === trumpValue);

      if (playedTrumps.length > 0) {
        playedTrumps.sort(
          (left, right) => suitHierarchy.indexOf(right.card.suit) - suitHierarchy.indexOf(left.card.suit)
        );
        const bestTrump = playedTrumps[0];
        winnerIndex = bestTrump.playerIndex;
        winnerName = bestTrump.playerName;
        bestCard = bestTrump.card;
      } else {
        room.tableCards.forEach((tableCard) => {
          tableCard.power = cardValuesHierarchy.indexOf(tableCard.card.value);
        });

        room.tableCards.sort((left, right) => right.power - left.power);

        if (room.tableCards.length > 1 && room.tableCards[0].power === room.tableCards[1].power) {
          isTie = true;
          winnerIndex = room.trickStarterIndex;
        } else {
          winnerIndex = room.tableCards[0].playerIndex;
          winnerName = room.tableCards[0].playerName;
          bestCard = room.tableCards[0].card;
        }
      }

      if (winnerIndex !== -1 && !isTie) {
        room.players[winnerIndex].tricksWon = (room.players[winnerIndex].tricksWon || 0) + 1;
      }

      const starterName = room.players[room.trickStarterIndex].name;
      const historyEntry = {
        isTie,
        winnerName,
        winningCard: bestCard,
        starterName
      };
      room.roundHistory.push(historyEntry);

      io.to(roomCode).emit('trick_resolved', {
        ...historyEntry,
        playerStates: buildPublicPlayerStates(room)
      });
      io.to(roomCode).emit('history_updated', { history: room.roundHistory });

      const activePlayers = room.players.filter((player) => !player.eliminated);
      room.cardsPlayedInRound += activePlayers.length;

      const totalCardsThisRound = (room.playableTricksThisRound || 0) * activePlayers.length;
      const isRoundEnd = room.cardsPlayedInRound >= totalCardsThisRound;

      if (isRoundEnd) {
        room.status = 'ROUND_END';
        calculateNaturalTricks(room.players);

        const roundResults = [];
        room.players.forEach((player) => {
          if (player.eliminated) {
            return;
          }

          const penalty = Math.abs((player.bet || 0) - (player.tricksWon || 0));
          player.lives -= penalty;

          if (player.lives <= 0) {
            player.lives = 0;
            player.eliminated = true;
            io.to(player.socketId).emit('player_eliminated', { name: player.name });
          }

          roundResults.push({
            name: player.name,
            bet: player.bet,
            tricksWon: player.tricksWon,
            penalty,
            lives: player.lives,
            eliminated: player.eliminated
          });
        });

        const survivors = room.players.filter((player) => !player.eliminated);
        io.to(roomCode).emit('round_results', {
          results: roundResults,
          playerStates: buildPublicPlayerStates(room)
        });

        if (survivors.length <= 1) {
          room.status = 'GAME_OVER';
          const champion = survivors[0];
          io.to(roomCode).emit('game_over', {
            winner: champion ? champion.name : 'Ninguém',
            playerStates: buildPublicPlayerStates(room)
          });
          return;
        }

        setTimeout(() => {
          room.deck = shuffle(createDeck());
          room.status = 'BETTING';
          room.currentTurnIndex = 0;
          room.trickStarterIndex = 0;
          room.tableCards = [];
          room.roundHistory = [];
          room.cardsPlayedInRound = 0;
          room.playableTricksThisRound = 0;
          room.round += 1;

          room.players.forEach((player) => {
            player.hand = [];
            player.tricksWon = 0;
            player.bet = null;

            if (player.eliminated) {
              return;
            }

            for (let i = 0; i < player.lives; i += 1) {
              player.hand.push(room.deck.pop());
            }
          });

          calculateGuaranteedTricks(survivors);

          survivors.forEach((player) => {
            io.to(player.socketId).emit('hand_dealt', { hand: player.hand, lives: player.lives });
          });

          room.currentTrump = room.deck.pop();
          room.cardsPerPlayer = survivors[0]?.hand.length || 1;
          room.playableTricksThisRound = Math.min(...survivors.map((player) => player.hand.length));

          io.to(roomCode).emit('new_round_started', {
            round: room.round,
            trump: room.currentTrump,
            cardsPerPlayer: room.cardsPerPlayer,
            players: room.players,
            playerStates: buildPublicPlayerStates(room)
          });
          emitTurnUpdate(roomCode, room, survivors[room.currentTurnIndex]?.socketId);

          console.log(`[NEW ROUND] Nova rodada iniciada na sala ${roomCode}.`);
        }, NEXT_ROUND_DELAY_MS);

        return;
      }

      room.tableCards = [];
      room.status = 'PLAYING';
      room.currentTurnIndex = winnerIndex;
      room.trickStarterIndex = winnerIndex;

      io.to(roomCode).emit('table_updated', {
        tableCards: room.tableCards,
        playerStates: buildPublicPlayerStates(room)
      });
      emitTurnUpdate(roomCode, room, room.players[room.currentTurnIndex].socketId);
    }, 2000);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`TF API Server listening on port ${PORT}`);
});
