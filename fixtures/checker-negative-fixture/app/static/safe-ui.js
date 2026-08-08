export function renderSafe(message) {
  const target = document.getElementById("message");
  target.textContent = message;
}

export function safeNavigation(nextPath) {
  const allowed = new Set(["/dashboard", "/help", "/logout"]);
  if (!allowed.has(nextPath)) {
    throw new Error("blocked navigation target");
  }
  location.assign(nextPath);
}

export function safeConfigReference() {
  return {
    apiKey: "${PUBLIC_RUNTIME_CONFIGURED_AT_DEPLOY}",
    internalHelp: "https://intranet.example.go.kr/help"
  };
}
