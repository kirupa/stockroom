// The order cart for the menu page. Keeps the cart in localStorage and marks
// items as sold out using the stock counts in /data/menu.json.

const CART_KEY = 'crumb-cart';

function loadCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || {};
  } catch {
    return {};
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

function addToCart(item) {
  const cart = loadCart();
  cart[item] = (cart[item] || 0) + 1;
  saveCart(cart);
  showStatus(`Added a ${item}. You have ${cart[item]} in your order.`);
}

function showStatus(message) {
  document.getElementById('cart-status').textContent = message;
}

async function markSoldOut() {
  const response = await fetch('/data/menu.json');
  const menu = await response.json();

  for (const entry of menu.items) {
    if (entry.left > 0) continue;
    const card = document.querySelector(`[data-item="${entry.id}"]`);
    if (!card) continue;
    card.classList.add('sold-out');
    card.querySelector('.button').disabled = true;
  }
}

markSoldOut();
