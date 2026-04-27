import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MENTOR_DIR = path.resolve(__dirname, "..");
const PORT = 3737;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 챌린지 문서 반환
app.get("/api/challenge", (_req, res) => {
  const filePath = path.join(
    MENTOR_DIR,
    "system-design/challenges/2026-04-05-traffic-surge.md"
  );
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "챌린지 파일을 찾을 수 없습니다" });
    return;
  }
  res.json({ content: fs.readFileSync(filePath, "utf-8") });
});

// 이론 파일 목록
app.get("/api/theory", (_req, res) => {
  const files: { name: string; path: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) {
        walk(full, `${prefix}/${f}`);
      } else if (f.endsWith(".md")) {
        files.push({ name: `${prefix}/${f}`.replace(/^\//, ""), path: full });
      }
    }
  };
  walk(path.join(MENTOR_DIR, "theory"), "");
  res.json(files);
});

// 특정 이론 파일 내용 (절대경로 기반 - 기존 호환)
app.get("/api/theory/content", (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath || !filePath.startsWith(MENTOR_DIR)) {
    res.status(400).json({ error: "잘못된 경로" });
    return;
  }
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "파일 없음" });
    return;
  }
  res.json({ content: fs.readFileSync(filePath, "utf-8") });
});

// 임의 문서 조회 (MENTOR_DIR 기준 상대경로)
app.get("/api/doc", (req, res) => {
  const relPath = req.query.path as string;
  if (!relPath) {
    res.status(400).json({ error: "경로 누락" });
    return;
  }
  const full = path.resolve(MENTOR_DIR, relPath);
  // path traversal 방지
  if (!full.startsWith(MENTOR_DIR + path.sep) || !full.endsWith(".md")) {
    res.status(400).json({ error: "잘못된 경로" });
    return;
  }
  if (!fs.existsSync(full)) {
    res.status(404).json({ error: "파일 없음" });
    return;
  }
  res.json({ content: fs.readFileSync(full, "utf-8") });
});

app.listen(PORT, () => {
  console.log(`\n백엔드 멘토 뷰어 실행 중: http://localhost:${PORT}\n`);
});
