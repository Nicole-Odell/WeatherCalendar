/*
 * The house's lights, through LightLine's REST API (see
 * /home/npodell/lightline/API.md), which runs on this Pi. The page asks this
 * server rather than LightLine, so it needs only one address and LightLine's
 * errors come back as ours.
 */
const LIGHTLINE_URL = process.env.LIGHTLINE_URL || 'http://localhost:5000';
// How long to wait for LightLine before giving up (ms)
const TIMEOUT = 5000;

async function lightline(path, options = {}) {
  const response = await fetch(`${LIGHTLINE_URL}/api/v1${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // (not JSON: an older LightLine without the REST API answers with a page)
  }
  if (!response.ok || body === null) {
    throw new Error(`LightLine ${path} failed (${response.status}): ${(body && body.error) || text.slice(0, 100)}`);
  }
  return body;
}

/** Returns whether the lights are on, as LightLine's master power: { powered } */
export async function GetPower() {
  return lightline('/power');
}

/** Returns the lights' global brightness, 0–1: { brightness } */
export async function GetBrightness() {
  return lightline('/brightness');
}

/** Sets the lights' global brightness (0–1), returning { brightness } */
export async function SetBrightness(brightness) {
  const value = Math.min(1, Math.max(0, Number(brightness)));
  if (!Number.isFinite(value)) throw new Error(`Not a brightness: ${brightness}`);
  return lightline('/brightness', { method: 'PUT', body: JSON.stringify({ brightness: value }) });
}

/** Turns the lights on or off (LightLine's master power), returning { powered } */
export async function SetPower(powered) {
  return lightline('/power', { method: 'PUT', body: JSON.stringify({ powered: Boolean(powered) }) });
}
