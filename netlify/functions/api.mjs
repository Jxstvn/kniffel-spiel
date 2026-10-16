import { randomInt, randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORE = "kniffel-rooms";
const SCORE_KEYS = ["ones", "twos", "threes", "fours", "fives", "sixes", "threeKind", "fourKind", "fullHouse", "smallStraight", "largeStraight", "yahtzee", "chance"];
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL = 90_000;
const HEARTBEAT_WRITE_MS = 15_000;

export const config = {
  path: ["/api/create", "/api/join", "/api/state", "/api/leave", "/api/move", "/api/new"],
  method: ["POST"]
};

const store = () => getStore({ name: STORE, consistency: "strong", region: "eu-central-1" });
const roomKey = id => `rooms/${id}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const freshGame = () => ({
  players: [0, 1].map(() => ({ scores: Object.fromEntries(SCORE_KEYS.map(key => [key, null])) })),
  current: 0, round: 1, dice: [0, 0, 0, 0, 0], held: [false, false, false, false, false],
  rollsLeft: 3, over: false, rolling: [], rollId: 0
});
const validRoomId = value => typeof value === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(value);

async function loadRoom(blobs, id) {
  const raw = await blobs.get(roomKey(id), { type: "text" });
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveRoom(blobs, id, room) {
  await blobs.set(roomKey(id), JSON.stringify(room), { metadata: { contentType: "application/json" } });
}

function validGame(game) {
  if (!game || !Array.isArray(game.players) || game.players.length !== 2) return false;
  if (!Number.isInteger(game.current) || game.current < 0 || game.current > 1) return false;
  if (!Number.isInteger(game.round) || game.round < 1 || game.round > (game.over ? 14 : 13)) return false;
  if (!Array.isArray(game.dice) || game.dice.length !== 5 || game.dice.some(die => !Number.isInteger(die) || die < 0 || die > 6)) return false;
  if (!Array.isArray(game.held) || game.held.length !== 5 || game.held.some(value => typeof value !== "boolean")) return false;
  if (!Number.isInteger(game.rollsLeft) || game.rollsLeft < 0 || game.rollsLeft > 3) return false;
  if (typeof game.over !== "boolean" || !Array.isArray(game.rolling) || !Number.isInteger(game.rollId)) return false;
  return game.players.every(player => player && player.scores && SCORE_KEYS.every(key => {
    const value = player.scores[key];
    return value === null || (Number.isFinite(value) && value >= 0 && value <= 1000);
  }));
}

export default async request => {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Ungültige Anfrage." }, 400); }
  const blobs = store();
  const route = new URL(request.url).pathname;

  if (route === "/api/create") {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 14) : "";
    if (!name) return json({ error: "Bitte gib deinen Namen ein." }, 400);
    let id;
    for (let attempt = 0; attempt < 5; attempt++) {
      id = Array.from({ length: 6 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join("");
      if (!(await blobs.get(roomKey(id)))) break;
      id = null;
    }
    if (!id) return json({ error: "Es konnte gerade kein Raumcode erstellt werden. Bitte erneut versuchen." }, 503);
    const token = randomUUID();
    const room = {
      names: [name, null], tokens: [token, null], lastSeen: [Date.now(), null],
      game: null, version: 1
    };
    await saveRoom(blobs, id, room);
    return json({ roomId: id, seat: 0, token, version: room.version });
  }

  const id = typeof body.roomId === "string" ? body.roomId.toUpperCase().trim() : "";
  if (!validRoomId(id)) return json({ error: "Bitte gib einen gültigen sechsstelligen Raumcode ein." }, 400);

  if (route === "/api/join") {
    let room = await loadRoom(blobs, id);
    if (room && room.lastSeen.some(time => time && Date.now() - time > ROOM_TTL)) {
      await blobs.delete(roomKey(id));
      room = null;
    }
    if (!room) return json({ error: "Der Raum existiert nicht mehr. Bitte den Code prüfen oder einen neuen Raum erstellen." }, 404);
    const seat = room.names.findIndex(name => name === null);
    if (seat < 0) return json({ error: "Der Raum ist bereits voll." }, 409);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 14) : "";
    if (!name) return json({ error: "Bitte gib deinen Namen ein." }, 400);
    const token = randomUUID();
    room.names[seat] = name;
    room.tokens[seat] = token;
    room.lastSeen[seat] = Date.now();
    room.game = freshGame();
    room.version++;
    await saveRoom(blobs, id, room);
    return json({ roomId: id, seat, token, version: room.version });
  }

  const room = await loadRoom(blobs, id);
  if (!room) return json({ error: "Dieser Raum wurde geschlossen oder existiert nicht mehr." }, 404);

  const seat = body.seat;
  const token = body.token;
  if (!Number.isInteger(seat) || seat < 0 || seat > 1 || !room.names[seat] || room.tokens[seat] !== token) {
    return json({ error: "Die Verbindung zu diesem Raum ist abgelaufen." }, 403);
  }
  if (room.lastSeen.some(time => time && Date.now() - time > ROOM_TTL)) {
    await blobs.delete(roomKey(id));
    return json({ error: "Ein Spieler war zu lange nicht mehr da. Der Raum wurde geschlossen." }, 410);
  }

  if (route === "/api/state") {
    if (Date.now() - room.lastSeen[seat] >= HEARTBEAT_WRITE_MS) {
      room.lastSeen[seat] = Date.now();
      await saveRoom(blobs, id, room);
    }
    return json({ names: room.names, game: room.game, version: room.version, roomId: id });
  }

  if (route === "/api/leave") {
    await blobs.delete(roomKey(id));
    return json({ closed: true });
  }

  if (route === "/api/move") {
    if (!room.game || body.version !== room.version || room.game.current !== seat || room.game.over || !validGame(body.game)) {
      return json({ error: "Der Spielstand hat sich geändert oder dieser Zug ist nicht gültig." }, 409);
    }
    const game = body.game;
    game.players[1 - seat] = room.game.players[1 - seat];
    room.game = game;
    room.lastSeen[seat] = Date.now();
    room.version++;
    await saveRoom(blobs, id, room);
    return json({ version: room.version });
  }

  if (route === "/api/new") {
    if (!room.names.every(Boolean)) return json({ error: "Es warten noch nicht beide Spieler." }, 409);
    room.game = freshGame();
    room.lastSeen[seat] = Date.now();
    room.version++;
    await saveRoom(blobs, id, room);
    return json({ version: room.version });
  }

  return json({ error: "Endpunkt nicht gefunden." }, 404);
};
