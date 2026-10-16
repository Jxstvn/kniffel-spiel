import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await copyFile("index.html", "dist/index.html");
await copyFile("vlipsy-creepy-face-jump-scare-3hEsFXt9.mp4", "dist/vlipsy-creepy-face-jump-scare-3hEsFXt9.mp4");
