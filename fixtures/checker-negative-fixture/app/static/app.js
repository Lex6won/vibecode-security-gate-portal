export function renderUnsafe(message) {
  document.getElementById("message").innerHTML = message;
}

export function runUnsafe(source) {
  return new Function(source)();
}
