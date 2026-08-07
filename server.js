const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createDeck, shuffle } = require('./deck');

// Hierarquia de cartas (Truco / clássico: 4 é fraco, 3 é forte)
const cardValuesHierarchy = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'];

// Força dos naipes para desempate de Trunfo (Manilha)
// Ramo > Taça > Espada > Moeda
const suitHierarchy = ['ouros', 'espadas', 'copas', 'paus']; // Índice maior = mais forte

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

// Estrutura em memória para armazenar as salas
const rooms = {};

// Função auxiliar para gerar códigos de sala com 4 letras/números
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
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
    io.to(roomCode).emit('room_updated', { players: rooms[roomCode].players });
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
    io.to(roomCode).emit('room_updated', { players: room.players });
  });

  socket.on('quick_match', (data) => {
    const { playerName } = data;
    let joined = false;

    for (const code in rooms) {
      const room = rooms[code];
      if (!room.isPrivate && room.status === 'WAITING' && room.players.length < 5) {
        room.players.push({ socketId: socket.id, name: playerName });
        socket.join(code);
        console.log(`[QUICK MATCH] ${playerName} joined room ${code}`);
        io.to(code).emit('room_joined', { roomCode: code, room });
        io.to(code).emit('room_updated', { players: room.players });
        joined = true;
        break;
      }
    }

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
      io.to(roomCode).emit('room_updated', { players: rooms[roomCode].players });
    }
  });

  socket.on('start_game', (data) => {
    const { roomCode } = data;
    const room = rooms[roomCode];
    if (room && room.status === 'WAITING') {
      room.deck = shuffle(createDeck());
      room.status = 'BETTING';
      room.currentTurnIndex = 0;
      room.trickStarterIndex = 0;
      room.tableCards = [];
      room.roundHistory = [];
      room.cardsPlayedInRound = 0;
      room.cardsPerPlayer = 0;

      room.players.forEach((player) => {
        player.hand = [];
        player.tricksWon = 0;
        player.lives = player.lives !== undefined ? player.lives : 5;
        const cardCount = player.lives;
        for (let i = 0; i < cardCount; i++) {
          player.hand.push(room.deck.pop());
        }
      });

      calculateGuaranteedTricks(room.players);

      room.players.forEach((player) => {
        io.to(player.socketId).emit('hand_dealt', { hand: player.hand, lives: player.lives });
      });

      room.currentTrump = room.deck.pop();
      room.cardsPerPlayer = room.players.filter((player) => !player.eliminated)[0]?.hand.length || 5;
      room.playableTricksThisRound = Math.min(...room.players.filter((player) => !player.eliminated).map((player) => player.hand.length));

      io.to(roomCode).emit('round_started', { trump: room.currentTrump, cardsPerPlayer: room.cardsPerPlayer });
      io.to(roomCode).emit('turn_update', { currentPlayerId: room.players[room.currentTurnIndex].socketId });

      console.log(`[START] Game started in room ${roomCode}. Round: ${room.round}`);
    }
  });

  socket.on('make_bet', (data) => {
    const { roomCode, bet } = data;
    const room = rooms[roomCode];

    if (!room || room.status !== 'BETTING') {
      return;
    }

    const currentPlayer = room.players[room.currentTurnIndex];
    if (socket.id !== currentPlayer.socketId) {
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
      for (let i = 0; i < activePlayers.length - 1; i++) {
        sum += activePlayers[i].bet || 0;
      }
      if (sum + bet === room.cardsPerPlayer) {
        socket.emit('bet_error', { message: 'A soma das apostas não pode empatar com o número de cartas!' });
        return;
      }
    }

    currentPlayer.bet = bet;
    room.currentTurnIndex++;

    if (room.currentTurnIndex >= room.players.length) {
      room.status = 'PLAYING';
      room.currentTurnIndex = room.trickStarterIndex || 0;
      io.to(roomCode).emit('playing_started', { message: 'As apostas terminaram! A fase de jogo começou.' });
      io.to(roomCode).emit('turn_update', { currentPlayerId: room.players[room.currentTurnIndex].socketId });
    } else {
      io.to(roomCode).emit('turn_update', { currentPlayerId: room.players[room.currentTurnIndex].socketId });
    }
  });

  socket.on('play_card', (data) => {
    const { roomCode, card } = data;
    const room = rooms[roomCode];

    if (!room || room.status !== 'PLAYING') {
      return;
    }

    const currentPlayer = room.players[room.currentTurnIndex];
    if (socket.id !== currentPlayer.socketId) {
      socket.emit('error', { message: 'Aguarde sua vez de jogar.' });
      return;
    }

    if (room.tableCards.length === 0) {
      room.trickStarterIndex = room.currentTurnIndex;
    }

    const cardIndex = currentPlayer.hand.findIndex((currentCard) => currentCard.value === card.value && currentCard.suit === card.suit);
    if (cardIndex !== -1) {
      currentPlayer.hand.splice(cardIndex, 1);
    }

    room.tableCards.push({
      playerIndex: room.currentTurnIndex,
      playerName: currentPlayer.name,
      card
    });

    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;

    io.to(roomCode).emit('table_updated', { tableCards: room.tableCards });
    io.to(roomCode).emit('turn_update', { currentPlayerId: room.players[room.currentTurnIndex].socketId });

    if (room.tableCards.length === room.players.length) {
      room.status = 'RESOLVING_TRICK';

      setTimeout(() => {
        let winnerName = '';
        let isTie = false;
        let winnerIndex = -1;
        let bestCard = null;

        const trumpValue = room.currentTrump.value;
        const playedTrumps = room.tableCards.filter((tableCard) => tableCard.card.value === trumpValue);

        if (playedTrumps.length > 0) {
          playedTrumps.sort((left, right) => suitHierarchy.indexOf(right.card.suit) - suitHierarchy.indexOf(left.card.suit));
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

        io.to(roomCode).emit('trick_resolved', historyEntry);
        io.to(roomCode).emit('history_updated', { history: room.roundHistory });

        room.cardsPlayedInRound += room.players.filter((player) => !player.eliminated).length;
        console.log(
          `[TRICK] Cartas jogadas na rodada: ${room.cardsPlayedInRound} / ${
            room.cardsPerPlayer * room.players.filter((player) => !player.eliminated).length
          }`
        );

        const activePlayers = room.players.filter((player) => !player.eliminated);
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
            const wasEliminated = player.lives <= 0;
            if (wasEliminated) {
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
          io.to(roomCode).emit('round_results', { results: roundResults });

          if (survivors.length <= 1) {
            room.status = 'GAME_OVER';
            const champion = survivors[0];
            io.to(roomCode).emit('game_over', { winner: champion ? champion.name : 'Ninguém' });
          } else {
            setTimeout(() => {
              room.deck = shuffle(createDeck());
              room.status = 'BETTING';
              room.currentTurnIndex = 0;
              room.trickStarterIndex = 0;
              room.tableCards = [];
              room.roundHistory = [];
              room.cardsPlayedInRound = 0;
              room.playableTricksThisRound = 0;

              room.players.forEach((player) => {
                player.hand = [];
                player.tricksWon = 0;
                player.bet = 0;
                if (player.eliminated) {
                  return;
                }

                for (let i = 0; i < player.lives; i++) {
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
                trump: room.currentTrump,
                cardsPerPlayer: room.cardsPerPlayer,
                players: room.players
              });
              io.to(roomCode).emit('turn_update', { currentPlayerId: survivors[room.currentTurnIndex]?.socketId });

              console.log(`[NEW ROUND] Nova rodada iniciada na sala ${roomCode}.`);
            }, NEXT_ROUND_DELAY_MS);
          }
        } else {
          room.tableCards = [];
          room.status = 'PLAYING';
          room.currentTurnIndex = winnerIndex;
          room.trickStarterIndex = winnerIndex;

          io.to(roomCode).emit('table_updated', { tableCards: room.tableCards });
          io.to(roomCode).emit('turn_update', { currentPlayerId: room.players[room.currentTurnIndex].socketId });
        }
      }, 2000);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`TF API Server listening on port ${PORT}`);
});
