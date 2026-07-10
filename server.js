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

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
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
  const activePlayers = players.filter(player => !player.eliminated);

  activePlayers.forEach(player => {
    if (activePlayers.length === 1) {
      player.guaranteedTricks = player.hand.length;
      return;
    }

    const maxOtherHand = Math.max(
      ...activePlayers
        .filter(otherPlayer => otherPlayer !== player)
        .map(otherPlayer => otherPlayer.hand.length)
    );

    player.guaranteedTricks = Math.max(0, player.hand.length - maxOtherHand);
  });
}

function calculateNaturalTricks(players) {
  const activePlayers = players.filter(player => !player.eliminated);

  activePlayers.forEach(player => {
    if (activePlayers.length === 1) {
      player.tricksWon = (player.tricksWon || 0) + player.hand.length;
      return;
    }

    const maxOtherHand = Math.max(
      ...activePlayers
        .filter(otherPlayer => otherPlayer !== player)
        .map(otherPlayer => otherPlayer.hand.length)
    );

    const naturalTricks = Math.max(0, player.hand.length - maxOtherHand);
    player.tricksWon = (player.tricksWon || 0) + naturalTricks;
  });
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Evento: create_room
  socket.on('create_room', (data) => {
    const { playerName, isPrivate } = data;
    
    let roomCode = generateRoomCode();
    // Garante que o código é único
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
    
    // Responde ao cliente com o código da sala
    socket.emit('room_created', { roomCode, room: rooms[roomCode] });
    io.to(roomCode).emit('room_updated', { players: rooms[roomCode].players });
  });

  // Evento: join_room
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
    
    // Atualiza todos os jogadores na sala
    io.to(roomCode).emit('room_joined', { roomCode, room });
    io.to(roomCode).emit('room_updated', { players: room.players });
  });

  // Evento: quick_match
  socket.on('quick_match', (data) => {
    const { playerName } = data;
    let joined = false;

    // Busca por uma sala pública com espaço
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

    // Se não encontrou nenhuma sala, cria uma nova
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

  // Evento: start_game
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
      room.cardsPerPlayer = 0; // será calculado após distribuição
      
      // Distribui cartas para cada jogador (quantidade = vidas atuais do jogador)
      room.players.forEach(player => {
        player.hand = [];
        player.tricksWon = 0;
        player.lives = player.lives !== undefined ? player.lives : 5; // Vidas iniciais = 5 cartas
        const cardCount = player.lives; // Vidas = quantidade de cartas
        for (let i = 0; i < cardCount; i++) {
          player.hand.push(room.deck.pop());
        }
      });

      // Cálculo de Vazas Naturais Garantidas
      calculateGuaranteedTricks(room.players);

      room.players.forEach(player => {
        // Envia as cartas de forma privada para o socket do jogador
        io.to(player.socketId).emit('hand_dealt', { hand: player.hand, lives: player.lives });
      });

      // Vira a carta trunfo
      room.currentTrump = room.deck.pop();

      // Notifica todos na sala que a rodada de apostas começou
      // Envia também quantas cartas foram distribuídas (para limitar o stepper de apostas)
      room.cardsPerPlayer = room.players.filter(p => !p.eliminated)[0]?.hand.length || 5;
      room.playableTricksThisRound = Math.min(...room.players.filter(p => !p.eliminated).map(p => p.hand.length));
      io.to(roomCode).emit('round_started', { trump: room.currentTrump, cardsPerPlayer: room.cardsPerPlayer });
      io.to(roomCode).emit('turn_update', { currentPlayerId: room.players[room.currentTurnIndex].socketId });
      
      console.log(`[START] Game started in room ${roomCode}. Round: ${room.round}`);
    }
  });

  // Evento: make_bet
  socket.on('make_bet', (data) => {
    const { roomCode, bet } = data;
    const room = rooms[roomCode];

    if (!room || room.status !== 'BETTING') return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (socket.id !== currentPlayer.socketId) {
      socket.emit('bet_error', { message: 'Aguarde a sua vez de apostar.' });
      return;
    }

    if (bet < (currentPlayer.guaranteedTricks || 0)) {
      socket.emit('bet_error', { message: `Você é obrigado a apostar pelo menos as suas vazas garantidas (${currentPlayer.guaranteedTricks})!` });
      return;
    }

    // Regra do último jogador (não pode empatar)
    const activePlayers = room.players.filter(p => !p.eliminated);
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
      room.currentTurnIndex = room.trickStarterIndex || 0; // Começa a vaza quem for o abridor
      io.to(roomCode).emit('playing_started', { message: 'As apostas terminaram! A fase de jogo começou.' });
      io.to(roomCode).emit('turn_update', { currentPlayerId: room.players[room.currentTurnIndex].socketId });
    } else {
      io.to(roomCode).emit('turn_update', { currentPlayerId: room.players[room.currentTurnIndex].socketId });
    }
  });

  // Evento: play_card
  socket.on('play_card', (data) => {
    const { roomCode, card } = data;
    const room = rooms[roomCode];

    if (!room || room.status !== 'PLAYING') return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (socket.id !== currentPlayer.socketId) {
      socket.emit('error', { message: 'Aguarde sua vez de jogar.' });
      return;
    }

    // Se a mesa estiver vazia, o jogador atual é o que inicia a vaza
    if (room.tableCards.length === 0) {
      room.trickStarterIndex = room.currentTurnIndex;
    }

    // Remove a carta da mão no servidor (segurança)
    const cardIndex = currentPlayer.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
    if (cardIndex !== -1) {
      currentPlayer.hand.splice(cardIndex, 1);
    }

    room.tableCards.push({
      playerIndex: room.currentTurnIndex,
      playerName: currentPlayer.name,
      card: card
    });

    // Avança turno circularmente
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;

    io.to(roomCode).emit('table_updated', { tableCards: room.tableCards });
    io.to(roomCode).emit('turn_update', { currentPlayerId: room.players[room.currentTurnIndex].socketId });

    // Se todos jogaram, avalia a vaza
    if (room.tableCards.length === room.players.length) {
      room.status = 'RESOLVING_TRICK';
      
      setTimeout(() => {
        let winnerName = '';
        let isTie = false;
        let winnerIndex = -1;
        let bestCard = null;

        const trumpValue = room.currentTrump.value;
        const playedTrumps = room.tableCards.filter(tc => tc.card.value === trumpValue);

        if (playedTrumps.length > 0) {
          // Desempate por naipe do trunfo
          playedTrumps.sort((a, b) => suitHierarchy.indexOf(b.card.suit) - suitHierarchy.indexOf(a.card.suit));
          const bestTrump = playedTrumps[0];
          winnerIndex = bestTrump.playerIndex;
          winnerName = bestTrump.playerName;
          bestCard = bestTrump.card;
        } else {
          // Não há trunfos, avalia carta mais alta
          room.tableCards.forEach(tc => {
            tc.power = cardValuesHierarchy.indexOf(tc.card.value);
          });
          
          room.tableCards.sort((a, b) => b.power - a.power);
          
          if (room.tableCards.length > 1 && room.tableCards[0].power === room.tableCards[1].power) {
            // Bucha! (Empate das maiores cartas)
            isTie = true;
            winnerIndex = room.trickStarterIndex; // Turno volta pro iniciador
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

        // Incrementa o contador de cartas jogadas na rodada
        room.cardsPlayedInRound += room.players.filter(p => !p.eliminated).length;
        console.log(`[TRICK] Cartas jogadas na rodada: ${room.cardsPlayedInRound} / ${room.cardsPerPlayer * room.players.filter(p => !p.eliminated).length}`);

        const activePlayers = room.players.filter(p => !p.eliminated);
        const totalCardsThisRound = (room.playableTricksThisRound || 0) * activePlayers.length;
        const isRoundEnd = room.cardsPlayedInRound >= totalCardsThisRound;

        if (isRoundEnd) {
          room.status = 'ROUND_END';
          calculateNaturalTricks(room.players);

          // --- Calcula vidas e eliminações ---
          const roundResults = [];
          room.players.forEach(p => {
            if (p.eliminated) return;
            const penalty = Math.abs((p.bet || 0) - (p.tricksWon || 0));
            p.lives -= penalty;
            const wasEliminated = p.lives <= 0;
            if (wasEliminated) {
              p.lives = 0;
              p.eliminated = true;
              io.to(p.socketId).emit('player_eliminated', { name: p.name });
            }
            roundResults.push({ name: p.name, bet: p.bet, tricksWon: p.tricksWon, penalty, lives: p.lives, eliminated: p.eliminated });
          });

          const survivors = room.players.filter(p => !p.eliminated);

          // Emite resultado da rodada para todos
          io.to(roomCode).emit('round_results', { results: roundResults });

          if (survivors.length <= 1) {
            room.status = 'GAME_OVER';
            const champion = survivors[0];
            io.to(roomCode).emit('game_over', { winner: champion ? champion.name : 'Ninguém' });
          } else {
            // --- Inicia nova rodada automaticamente após 5 segundos ---
            setTimeout(() => {
              room.deck = shuffle(createDeck());
              room.status = 'BETTING';
              room.currentTurnIndex = 0;
              room.trickStarterIndex = 0;
              room.tableCards = [];
              room.roundHistory = [];
              room.cardsPlayedInRound = 0;
              room.playableTricksThisRound = 0;

              // Distribui conforme vidas restantes
              room.players.forEach(p => {
                p.hand = [];
                p.tricksWon = 0;
                p.bet = 0;
                if (p.eliminated) return;
                for (let i = 0; i < p.lives; i++) {
                  p.hand.push(room.deck.pop());
                }
              });

              calculateGuaranteedTricks(survivors);

              survivors.forEach(p => {
                io.to(p.socketId).emit('hand_dealt', { hand: p.hand, lives: p.lives });
              });

              room.currentTrump = room.deck.pop();
              room.cardsPerPlayer = survivors[0]?.hand.length || 1;
              room.playableTricksThisRound = Math.min(...survivors.map(p => p.hand.length));

              io.to(roomCode).emit('new_round_started', { trump: room.currentTrump, cardsPerPlayer: room.cardsPerPlayer, players: room.players });
              io.to(roomCode).emit('turn_update', { currentPlayerId: survivors[room.currentTurnIndex]?.socketId });

              console.log(`[NEW ROUND] Nova rodada iniciada na sala ${roomCode}.`);
            }, 5000);
          }
        } else {
          // Próxima vaza normal
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
    // Em um cenário real, aqui seria tratada a remoção do jogador da sala.
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`TF API Server listening on port ${PORT}`);
});
