const suits = ['ouros', 'copas', 'espadas', 'paus'];
const values = ['A', '2', '3', '4', '5', '6', '7', '10', '11', '12'];

function createDeck() {
  const deck = [];
  for (const suit of suits) {
    for (const value of values) {
      deck.push({ suit, value });
    }
  }
  return deck;
}

function shuffle(deck) {
  const newDeck = [...deck];
  // Algoritmo de Fisher-Yates
  for (let i = newDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
  }
  return newDeck;
}

module.exports = {
  createDeck,
  shuffle
};
