"""演示脚本：一个真实的贪吃蛇小游戏，以及它被"写出来"的步骤序列。

设计要点
--------
1. 步骤里的内容拼起来，必须**一字不差**地等于最终文件（不然演出来的是假代码）。
   所以这里是拿最终文件反过来切块生成的，而不是手写一堆碎片。
2. 文件之间有交错（写完 js 的一半，跳去 css 补一个类名，再回来），
   但每个文件内部的顺序保持不变 —— 这样既像人，又保证结果正确。
"""

from __future__ import annotations

from typing import Any


FILES: dict[str, str] = {
    "index.html": """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>贪吃蛇</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="hud">
    <span>得分 <b id="score">0</b></span>
    <span>最高 <b id="best">0</b></span>
  </div>
  <canvas id="board" width="420" height="420"></canvas>
  <p class="tip">方向键移动 · 空格重开</p>
  <script src="game.js"></script>
</body>
</html>
""",
    "style.css": """* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: radial-gradient(circle at 50% 0%, #1b2130, #0f1115 60%);
  color: #e6e9ef;
  font-family: -apple-system, "PingFang SC", system-ui, sans-serif;
}

.hud {
  display: flex;
  gap: 28px;
  font-size: 14px;
  color: #8b93a7;
}

.hud b {
  color: #3ddc97;
  font-variant-numeric: tabular-nums;
}

canvas {
  border-radius: 14px;
  background: #161a22;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.06);
}

.tip {
  margin: 0;
  font-size: 12px;
  color: #8b93a7;
}

body.dead canvas {
  box-shadow: 0 0 0 1px rgba(255, 99, 99, 0.5), 0 20px 50px rgba(0, 0, 0, 0.45);
}

body.dead .hud b {
  color: #ff6363;
}
""",
    "game.js": """const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const CELL = 21;
const COLS = canvas.width / CELL;
const ROWS = canvas.height / CELL;

const scoreEl = document.getElementById("score");
const bestEl = document.getElementById("best");

let snake;
let dir;
let queued;
let food;
let score;
let best = Number(localStorage.getItem("snake-best") || 0);
let timer;
let dead = false;

const KEYS = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

function randomFood() {
  while (true) {
    const spot = {
      x: Math.floor(Math.random() * COLS),
      y: Math.floor(Math.random() * ROWS),
    };
    if (!snake.some((s) => s.x === spot.x && s.y === spot.y)) return spot;
  }
}

function reset() {
  snake = [{ x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
  dir = { x: 1, y: 0 };
  queued = dir;
  score = 0;
  dead = false;
  food = randomFood();
  document.body.classList.remove("dead");
  updateHud();
  draw();
  clearInterval(timer);
  timer = setInterval(step, 110);
}

function updateHud() {
  scoreEl.textContent = score;
  bestEl.textContent = best;
}

function step() {
  if (dead) return;
  dir = queued;

  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
  const hitWall = head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS;
  const hitSelf = snake.some((s) => s.x === head.x && s.y === head.y);
  if (hitWall || hitSelf) return end();

  snake.unshift(head);

  if (head.x === food.x && head.y === food.y) {
    score += 10;
    if (score > best) {
      best = score;
      localStorage.setItem("snake-best", best);
    }
    food = randomFood();
    updateHud();
  } else {
    snake.pop();
  }

  draw();
}

function end() {
  dead = true;
  clearInterval(timer);
  document.body.classList.add("dead");
  draw();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  drawFood();
  drawSnake();
}

function drawGrid() {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i += 1) {
    ctx.beginPath();
    ctx.moveTo(i * CELL, 0);
    ctx.lineTo(i * CELL, canvas.height);
    ctx.stroke();
  }
  for (let j = 1; j < ROWS; j += 1) {
    ctx.beginPath();
    ctx.moveTo(0, j * CELL);
    ctx.lineTo(canvas.width, j * CELL);
    ctx.stroke();
  }
}

function drawFood() {
  const x = food.x * CELL + CELL / 2;
  const y = food.y * CELL + CELL / 2;
  ctx.fillStyle = "#ff9f43";
  ctx.beginPath();
  ctx.arc(x, y, CELL * 0.3, 0, Math.PI * 2);
  ctx.fill();
}

function drawSnake() {
  snake.forEach((seg, index) => {
    const pad = index === 0 ? 2 : 3;
    ctx.fillStyle = index === 0 ? "#3ddc97" : "rgba(61, 220, 151, 0.55)";
    ctx.beginPath();
    ctx.roundRect(
      seg.x * CELL + pad,
      seg.y * CELL + pad,
      CELL - pad * 2,
      CELL - pad * 2,
      6,
    );
    ctx.fill();
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === " ") {
    event.preventDefault();
    reset();
    return;
  }
  const next = KEYS[event.key];
  if (!next) return;
  if (next.x === -dir.x && next.y === -dir.y) return;
  queued = next;
  event.preventDefault();
});

reset();
""",
}

BANNERS = {
    "index.html": "正在编写页面结构",
    "style.css": "正在调整样式",
    "game.js": "正在实现游戏逻辑",
}

SAY = {
    "index.html": "先把页面骨架搭出来：一块画布，上面放分数。",
    "style.css": "给它一点舞台感——深色背景、圆角、一点辉光。",
    "game.js": "然后是核心：蛇怎么走、怎么吃、怎么撞死。",
}


def _chunks(text: str, size: int) -> list[str]:
    lines = text.splitlines(keepends=True)
    return ["".join(lines[i : i + size]) for i in range(0, len(lines), size)]


def _emit(steps: list[dict[str, Any]], path: str, chunks: list[str], lo: int, hi: int) -> None:
    for chunk in chunks[lo:hi]:
        steps.append(
            {"type": "append", "path": path, "text": chunk, "banner": BANNERS[path]}
        )


def build_steps() -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []

    html = _chunks(FILES["index.html"], 4)
    css = _chunks(FILES["style.css"], 4)
    js = _chunks(FILES["game.js"], 4)

    steps.append(
        {
            "type": "say",
            "text": "好，做一个贪吃蛇。我先列一下要动哪几个文件：index.html、style.css、game.js。",
            "delay": 1200,
        }
    )

    # ---- index.html
    steps.append({"type": "say", "text": SAY["index.html"], "delay": 900})
    steps.append(
        {
            "type": "create",
            "path": "index.html",
            "banner": "正在创建 index.html",
            "delay": 600,
        }
    )
    _emit(steps, "index.html", html, 0, len(html))

    # ---- style.css 前半
    steps.append({"type": "say", "text": SAY["style.css"], "delay": 900})
    steps.append(
        {"type": "create", "path": "style.css", "banner": "正在创建 style.css", "delay": 600}
    )
    _emit(steps, "style.css", css, 0, 5)

    # ---- game.js 前半（回到已有文件，表现"来回切"）
    steps.append({"type": "say", "text": SAY["game.js"], "delay": 900})
    steps.append(
        {"type": "create", "path": "game.js", "banner": "正在创建 game.js", "delay": 600}
    )
    _emit(steps, "game.js", js, 0, 6)

    # ---- 回到 css：补"撞死"的样式（这里是一个自以为是的时刻）
    steps.append(
        {
            "type": "say",
            "text": "等等——撞死的时候得让画面有点反应，先回 css 补两行。",
            "delay": 1100,
        }
    )
    steps.append({"type": "open", "path": "style.css", "banner": "回到 style.css", "delay": 500})
    _emit(steps, "style.css", css, 5, len(css))

    # ---- 回 js 收尾
    steps.append({"type": "open", "path": "game.js", "banner": "回到 game.js", "delay": 500})
    _emit(steps, "game.js", js, 6, len(js))

    steps.append(
        {"type": "say", "text": "写完了，跑一下看看。", "delay": 700}
    )
    steps.append(
        {
            "type": "run",
            "cmd": "open index.html",
            "banner": "正在打开预览",
            "delay": 900,
        }
    )
    steps.append(
        {
            "type": "done",
            "text": "可以玩了，方向键控制，空格重开。",
            "delay": 600,
        }
    )
    return steps
