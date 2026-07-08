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
      room.round++;
      room.deck = shuffle(createDeck());
      room.status = 'BETTING';
      room.currentTurnIndex = 0;
      room.trickStarterIndex = 0;
      room.tableCards = [];
      
      // Distribui cartas para cada jogador
      room.players.forEach(player => {
        player.hand = [];
        player.tricksWon = 0;
        player.lives = player.lives !== undefined ? player.lives : 5; // Configura vidas iniciais
        for (let i = 0; i < room.round; i++) {
          player.hand.push(room.deck.pop());
        }
      });

      // Cálculo de Vazas Naturais Garantidas
      room.players.forEach(player => {
        if (room.players.length > 1) {
          const maxOtherHand = Math.max(...room.players.filter(p => p !== player && !p.eliminated).map(p => p.hand.length));
          player.guaranteedTricks = Math.max(0, player.hand.length - maxOtherHand);
        } else {
          player.guaranteedTricks = player.hand.length;
        }
        // Envia as cartas de forma privada para o socket do jogador
        io.to(player.socketId).emit('hand_dealt', { hand: player.hand });
      });

      // Vira a carta trunfo
      room.currentTrump = room.deck.pop();

      // Notifica todos na sala que a rodada de apostas começou
      io.to(roomCode).emit('round_started', { round: room.round, trump: room.currentTrump });
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
    if (room.currentTurnIndex === room.players.length - 1) {
      let sum = 0;
      for (let i = 0; i < room.players.length - 1; i++) {
        sum += room.players[i].bet;
      }
      if (sum + bet === room.round) {
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

        const trumpValue = room.currentTrump.value;
        const playedTrumps = room.tableCards.filter(tc => tc.card.value === trumpValue);

        if (playedTrumps.length > 0) {
          // Desempate por naipe do trunfo
          playedTrumps.sort((a, b) => suitHierarchy.indexOf(b.card.suit) - suitHierarchy.indexOf(a.card.suit));
          const bestTrump = playedTrumps[0];
          winnerIndex = bestTrump.playerIndex;
          winnerName = bestTrump.playerName;
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
          }
        }

        if (winnerIndex !== -1 && !isTie) {
          room.players[winnerIndex].tricksWon = (room.players[winnerIndex].tricksWon || 0) + 1;
        }

        io.to(roomCode).emit('trick_resolved', { isTie, winnerName });

        // Verifica se a rodada inteira acabou (todos sem cartas)
        const activePlayers = room.players.filter(p => !p.eliminated);
        const isRoundEnd = activePlayers.every(p => p.hand.length === 0);

        if (isRoundEnd) {
          room.status = 'ROUND_END';
          let survivors = 0;
          let lastWinner = null;

          room.players.forEach(p => {
            if (p.eliminated) return;
            const penalty = Math.abs((p.bet || 0) - (p.tricksWon || 0));
            
            if (penalty >= p.lives) {
              p.eliminated = true;
              p.lives = 0;
            } else {
              p.lives -= penalty;
              survivors++;
              lastWinner = p;
            }
          });

          if (survivors <= 1) {
            room.status = 'GAME_OVER';
            io.to(roomCode).emit('game_over', { winner: lastWinner ? lastWinner.name : 'Ninguém' });
          } else {
            // Avisa o fim da rodada para prosseguir para a próxima (após delay ou clique na UI)
            io.to(roomCode).emit('round_end', { players: room.players });
          }
        } else {
          // Limpa a mesa para a próxima vaza
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
