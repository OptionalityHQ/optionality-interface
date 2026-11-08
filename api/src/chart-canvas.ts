export type SceneNode = {
  tag: string;
  attrs: Record<string, string | number>;
  text?: string;
  children: SceneNode[];
  append(...children: SceneNode[]): void;
};

export function sceneNode(
  tag: string,
  attrs: Record<string, string | number> = {},
  text?: string,
): SceneNode {
  const children: SceneNode[] = [];
  return {
    tag,
    attrs,
    text,
    children,
    append: (...items) => children.push(...items),
  };
}

export function paintScene(
  canvas: HTMLCanvasElement,
  scene: SceneNode,
  width: number,
  height: number,
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  if (
    canvas.width !== Math.round(width * ratio) ||
    canvas.height !== Math.round(height * ratio)
  ) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const clips = new Map<string, Record<string, string | number>>();
  for (const definition of scene.children.filter(
    (child) => child.tag === "defs",
  )) {
    for (const clip of definition.children)
      if (clip.children[0])
        clips.set(String(clip.attrs.id), clip.children[0].attrs);
  }
  function paint(item: SceneNode): void {
    if (item.tag === "defs") return;
    const attributes = item.attrs;
    const number = (key: string) => Number(attributes[key] ?? 0);
    context.save();
    if (attributes.opacity !== undefined)
      context.globalAlpha = number("opacity");
    const clipId = String(attributes["clip-path"] ?? "").match(
      /^url\(#(.+)\)$/,
    )?.[1];
    const clip = clipId ? clips.get(clipId) : null;
    if (clip) {
      context.beginPath();
      context.rect(
        Number(clip.x),
        Number(clip.y),
        Number(clip.width),
        Number(clip.height),
      );
      context.clip();
    }
    const path = new Path2D();
    if (item.tag === "rect") {
      const shapeWidth = Math.max(0, number("width")),
        shapeHeight = Math.max(0, number("height"));
      path.roundRect(
        number("x"),
        number("y"),
        shapeWidth,
        shapeHeight,
        Math.min(number("rx"), shapeWidth / 2, shapeHeight / 2),
      );
    } else if (item.tag === "line") {
      path.moveTo(number("x1"), number("y1"));
      path.lineTo(number("x2"), number("y2"));
    } else if (item.tag === "circle") {
      path.arc(number("cx"), number("cy"), number("r"), 0, Math.PI * 2);
    } else if (item.tag === "polyline") {
      const coordinates = String(attributes.points)
        .trim()
        .split(/[ ,]+/)
        .map(Number);
      for (let index = 0; index < coordinates.length; index += 2) {
        if (index === 0)
          path.moveTo(coordinates[index], coordinates[index + 1]);
        else path.lineTo(coordinates[index], coordinates[index + 1]);
      }
    }
    if (item.tag === "text") {
      context.font = `${attributes["font-size"] ?? 12}px ${attributes["font-family"] ?? '"Geist Mono", monospace'}`;
      context.fillStyle = String(attributes.fill ?? "#f4ede4");
      context.textAlign =
        attributes["text-anchor"] === "middle"
          ? "center"
          : attributes["text-anchor"] === "end"
            ? "right"
            : "left";
      context.fillText(item.text ?? "", number("x"), number("y"));
    } else {
      if (attributes.fill && attributes.fill !== "none") {
        context.fillStyle = String(attributes.fill);
        context.fill(path);
      }
      const stroke = attributes.stroke;
      if (stroke) {
        context.strokeStyle = String(stroke);
        context.lineWidth = Number(attributes["stroke-width"] ?? 1);
        context.lineJoin =
          attributes["stroke-linejoin"] === "round" ? "round" : "miter";
        context.lineCap =
          attributes["stroke-linecap"] === "round" ? "round" : "butt";
        context.setLineDash(
          String(attributes["stroke-dasharray"] ?? "")
            .split(/[ ,]+/)
            .filter(Boolean)
            .map(Number),
        );
        context.stroke(path);
      }
    }
    item.children.forEach(paint);
    context.restore();
  }
  paint(scene);
}
