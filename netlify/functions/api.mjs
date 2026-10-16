import { randomInt, randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORE = "kniffel-rooms";
const SCORE_KEYS = ["ones", "twos", "threes", "fours", "fives", "sixes", "threeKind", "fourKind", "fullHouse", "smallStraight", "largeStraight", "yahtzee", "chance"];
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL = 900_000;
const HEARTBEAT_WRITE_MS = 5_000;

export const config = {
  path: ["/api/create", "/api/join", "/api/state", "/api/leave", "/api/move", "/api/new"],
  method: ["POST"]
};

const store = () => getStore({ name: STORE, consistency: "strong", region: "eu-central-1" });
const roomKey = id => `rooms/${id}`;
const presenceKey = (id, seat) => `presence/${id}/${seat}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const freshGame = playerCount => ({
  players: Array.from({ length: playerCount }, () => ({ scores: Object.fromEntries(SCORE_KEYS.map(key => [key, null])) })),
  current: 0, round: 1, dice: [0, 0, 0, 0, 0], held: [false, false, false, false, false],
  rollsLeft: 3, over: false, rolling: [], rollId: 0, gameId: randomUUID()
});
const validRoomId = value => typeof value === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(value);

async function loadRoom(blobs, id) {
  const raw = await blobs.get(roomKey(id), { type: "text" });
  if (!raw) return null;
  try {
    const room = JSON.parse(raw);
    const validNames = Array.isArray(room?.names) && room.names.length >= 2 && room.names.length <= 4 &&
      room.names.every(name => name === null ||
        (typeof name === "string" && name.trim().length > 0 && name.length <= 14));
    const validTokens = Array.isArray(room?.tokens) && room.tokens.length === room.names?.length &&
      room.tokens.every(token => token === null || (typeof token === "string" && token.length > 0));
    const validPresence = room?.lastSeen === undefined ||
      (Array.isArray(room.lastSeen) && room.lastSeen.length === room.names?.length &&
        room.lastSeen.every(time => time === null || (Number.isFinite(time) && time >= 0)));
    const validSeats = room.names.every((name, seat) => Boolean(name) === Boolean(room.tokens[seat]));
    const validCapacity = room.maxPlayers === undefined || room.maxPlayers === room.names?.length;
    const validGameState = room.game === null || (room.names.every(Boolean) && validGame(room.game, room.names.length));
    if (!validNames || !validTokens || !validSeats || !validPresence || !Number.isInteger(room.version) ||
        !validCapacity || room.version < 1 || !validGameState) return null;
    return room;
  } catch {
    return null;
  }
}

async function saveRoom(blobs, id, room) {
  await blobs.set(roomKey(id), JSON.stringify(room), { metadata: { contentType: "application/json" } });
}

async function getRoomPresence(blobs, id, room) {
  return Promise.all(room.names.map(async (_, seat) => {
    const stored = await blobs.get(presenceKey(id, seat), { type: "text" });
    return Number(stored) || Number(room.lastSeen?.[seat]) || 0;
  }));
}

async function deleteRoom(blobs, id) {
  await Promise.all([
    blobs.delete(roomKey(id)),
    blobs.delete(presenceKey(id, 0)),
    blobs.delete(presenceKey(id, 1)),
    blobs.delete(presenceKey(id, 2)),
    blobs.delete(presenceKey(id, 3))
  ]);
}

async function touchPresence(blobs, id, seat, lastSeen) {
  const now = Date.now();
  if (now - lastSeen < HEARTBEAT_WRITE_MS) return;
  await blobs.set(presenceKey(id, seat), String(now));
}

function roomHasExpired(room, lastSeen) {
  const now = Date.now();
  return lastSeen.some((time, seat) => room.names[seat] && (!time || now - time > ROOM_TTL));
}

function validGame(game, playerCount) {
  if (!game || !Array.isArray(game.players) || game.players.length !== playerCount) return false;
  if (!Number.isInteger(game.current) || game.current < 0 || game.current >= playerCount) return false;
  if (!Number.isInteger(game.round) || game.round < 1 || game.round > (game.over ? 14 : 13)) return false;
  if (!Array.isArray(game.dice) || game.dice.length !== 5 || game.dice.some(die => !Number.isInteger(die) || die < 0 || die > 6)) return false;
  if (!Array.isArray(game.held) || game.held.length !== 5 || game.held.some(value => typeof value !== "boolean")) return false;
  if (!Number.isInteger(game.rollsLeft) || game.rollsLeft < 0 || game.rollsLeft > 3) return false;
  if (typeof game.over !== "boolean" || !Array.isArray(game.rolling) || game.rolling.length > 5) return false;
  if (new Set(game.rolling).size !== game.rolling.length || game.rolling.some(index => !Number.isInteger(index) || index < 0 || index > 4)) return false;
  if (!Number.isInteger(game.rollId) || game.rollId < 0) return false;
  if (game.gameId !== undefined && (typeof game.gameId !== "string" || game.gameId.length > 80)) return false;
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
    const playerCount = body.playerCount === undefined ? 2 : Number(body.playerCount);
    if (!Number.isInteger(playerCount) || playerCount < 2 || playerCount > 4) {
      return json({ error: "Ein Raum kann 2 bis 4 Spieler haben." }, 400);
    }
    let id;
    for (let attempt = 0; attempt < 5; attempt++) {
      id = Array.from({ length: 6 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join("");
      if (!(await blobs.get(roomKey(id)))) break;
      id = null;
    }
    if (!id) return json({ error: "Es konnte gerade kein Raumcode erstellt werden. Bitte erneut versuchen." }, 503);
    const token = randomUUID();
    const room = {
      maxPlayers: playerCount,
      names: Array.from({ length: playerCount }, (_, seat) => seat === 0 ? name : null),
      tokens: Array.from({ length: playerCount }, (_, seat) => seat === 0 ? token : null),
      game: null,
      version: 1
    };
    await blobs.set(presenceKey(id, 0), String(Date.now()));
    await saveRoom(blobs, id, room);
    return json({ roomId: id, seat: 0, token, version: room.version });
  }

  const id = typeof body.roomId === "string" ? body.roomId.toUpperCase().trim() : "";
  if (!validRoomId(id)) return json({ error: "Bitte gib einen gültigen sechsstelligen Raumcode ein." }, 400);

  if (route === "/api/join") {
    let room = await loadRoom(blobs, id);
    if (room && roomHasExpired(room, await getRoomPresence(blobs, id, room))) {
      await deleteRoom(blobs, id);
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
    if (room.names.every(Boolean)) room.game = freshGame(room.names.length);
    room.version++;
    await blobs.set(presenceKey(id, seat), String(Date.now()));
    await saveRoom(blobs, id, room);
    return json({ roomId: id, seat, token, version: room.version });
  }

  const room = await loadRoom(blobs, id);
  if (!room) return json({ error: "Dieser Raum wurde geschlossen oder existiert nicht mehr." }, 404);

  const seat = body.seat;
  const token = body.token;
  if (!Number.isInteger(seat) || seat < 0 || seat >= room.names.length || !room.names[seat] || room.tokens[seat] !== token) {
    return json({ error: "Die Verbindung zu diesem Raum ist abgelaufen." }, 403);
  }
  const lastSeen = await getRoomPresence(blobs, id, room);
  if (roomHasExpired(room, lastSeen)) {
    await deleteRoom(blobs, id);
    return json({ error: "Ein Spieler war zu lange nicht mehr da. Der Raum wurde geschlossen." }, 410);
  }

  if (route === "/api/state") {
    await touchPresence(blobs, id, seat, lastSeen[seat]);
    if (room.game?.history) {
      delete room.game.history;
      await saveRoom(blobs, id, room);
    }
    const now = Date.now();
    const online = room.names.map((name, playerSeat) => Boolean(name &&
      (playerSeat === seat || (lastSeen[playerSeat] > 0 && now - lastSeen[playerSeat] < 15_000))));
    return json({ names: room.names, online, game: room.game, version: room.version, roomId: id });
  }

  if (route === "/api/leave") {
    await deleteRoom(blobs, id);
    return json({ closed: true });
  }

  if (route === "/api/move") {
    if (!room.game || body.version !== room.version || room.game.current !== seat || room.game.over || !validGame(body.game, room.names.length)) {
      return json({ error: "Der Spielstand hat sich geändert oder dieser Zug ist nicht gültig." }, 409);
    }
    const game = body.game;
    delete game.history;
    game.players = game.players.map((player, index) => index === seat ? player : room.game.players[index]);
    room.game = game;
    room.version++;
    await saveRoom(blobs, id, room);
    await blobs.set(presenceKey(id, seat), String(Date.now()));
    return json({ version: room.version });
  }

  if (route === "/api/new") {
    if (!room.names.every(Boolean)) return json({ error: "Es warten noch nicht alle Spieler." }, 409);
    room.game = freshGame(room.names.length);
    room.version++;
    await saveRoom(blobs, id, room);
    await blobs.set(presenceKey(id, seat), String(Date.now()));
    return json({ version: room.version });
  }

  return json({ error: "Endpunkt nicht gefunden." }, 404);
};
