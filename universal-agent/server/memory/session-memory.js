let sessionMemory = [];

export function addToSessionMemory({ task, result, timestamp }) {
  sessionMemory.push({ task, result, timestamp });
  if (sessionMemory.length > 20) {
    sessionMemory = sessionMemory.slice(-20);
  }
}

export function getSessionMemory() {
  return [...sessionMemory];
}

export function clearSessionMemory() {
  sessionMemory = [];
}

export function generateMemoryContext() {
  if (sessionMemory.length === 0) {
    return 'No prior tasks this session.';
  }

  return sessionMemory
    .map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString()}] "${entry.task}" -> ${entry.result}`)
    .join('\n');
}
