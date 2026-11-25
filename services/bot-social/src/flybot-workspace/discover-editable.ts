import { assert } from "../errors.js";
import type { OtContext } from "./core.js";

export const EDITABLE_WORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_listing_editable (
  listing_id TEXT PRIMARY KEY REFERENCES ot_listings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('slides','whiteboard')),
  content TEXT NOT NULL CHECK(json_valid(content))
);
`;

export const editableWorkKind = (kind: unknown): kind is "slides" | "whiteboard" => kind === "slides" || kind === "whiteboard";
const fields = (value: any, keys: string[]) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const within = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const title = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit && value === value.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const list = (items: unknown, minimum: number, maximum: number): items is any[] =>
  Array.isArray(items) && items.length >= minimum && items.length <= maximum;

function validSlides(deck: any) {
  return fields(deck,["schema","slides"]) && deck.schema === "flybot-workspace.slides.v1" && list(deck.slides,1,30) &&
    deck.slides.every((slide: any) => fields(slide,["title","bullets"]) && title(slide.title,120) &&
      list(slide.bullets,0,10) && slide.bullets.every((bullet: unknown) => title(bullet,200) && Boolean(bullet)) &&
      Boolean(slide.title || slide.bullets.length));
}

function validStroke(stroke: any) {
  if (typeof stroke?.id !== "string" || !/^[A-Za-z0-9_-]{8,32}$/.test(stroke.id) ||
      typeof stroke.color !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(stroke.color)) return false;
  const base = ["id","type","color"];
  if (stroke.type === "path") {
    return fields(stroke,[...base,"width","points"]) && within(stroke.width,1,40) && list(stroke.points,2,400) &&
      stroke.points.every((point: unknown) => list(point,2,2) && point.every(value => within(value,0,2000)));
  }
  if (!within(stroke.x,0,2000) || !within(stroke.y,0,2000)) return false;
  if (stroke.type === "rect" || stroke.type === "ellipse") {
    return fields(stroke,[...base,"x","y","width","height"]) &&
      within(stroke.width,1,2000) && within(stroke.height,1,2000);
  }
  return stroke.type === "text" && fields(stroke,[...base,"x","y","size","text"]) && within(stroke.size,8,96) &&
    typeof stroke.text === "string" && stroke.text.length >= 1 && stroke.text.length <= 200 && !/[\x00-\x08\x0a-\x1f]/.test(stroke.text);
}

function validBoard(board: any) {
  if (!fields(board,["schema","width","height","strokes"]) || board.schema !== "flybot-workspace.whiteboard.v1" ||
      !within(board.width,100,2000) || !Number.isInteger(board.width) || !within(board.height,100,2000) ||
      !Number.isInteger(board.height) || !list(board.strokes,0,200) || !board.strokes.every(validStroke)) return false;
  return new Set(board.strokes.map((stroke: {id: string}) => stroke.id)).size === board.strokes.length;
}

export function editableRelease(kind: unknown, snapshot: unknown) {
  if (snapshot === undefined) return null;
  assert(editableWorkKind(kind) && (kind === "slides" ? validSlides(snapshot) : validBoard(snapshot)),
    400,"invalid_editable_work","Provide an editable saved slide deck or whiteboard");
  const content = JSON.stringify(snapshot);
  // Native whiteboards use ASCII JSON on disk. Slides have the same character cap.
  const length = kind === "whiteboard" ? content.replace(/[\u007f-\uffff]/g,"xxxxxx").length : content.length;
  assert(length <= 65536,413,"editable_work_too_large","The editable work exceeds its saved format capacity");
  return {kind,content};
}

export function hasEditableRelease(ot: OtContext, work: {id: string; work_kind: unknown}) {
  return editableWorkKind(work.work_kind) &&
    Boolean(ot.get("SELECT 1 FROM ot_listing_editable WHERE listing_id=? AND kind=?",work.id,work.work_kind));
}
