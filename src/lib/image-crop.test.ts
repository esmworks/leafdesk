import { describe, expect, it } from "vitest";
import { clampCrop, cropCss, cropStyles, dragCrop, formatImageCrop, MIN_CROP, parseImageCrop, restoreImageCrops, type ImageCrop } from "./image-crop";

const crop: ImageCrop = { x: 0.1, y: 0.2, w: 0.5, h: 0.4, ar: 1.5 };

describe("image crops", () => {
  it("round-trip through the prop, and read anything else as none", () => {
    expect(parseImageCrop(formatImageCrop(crop))).toEqual(crop);
    expect(formatImageCrop(null)).toBe("");
    // The whole image is no crop.
    expect(formatImageCrop({ x: 0, y: 0, w: 1, h: 1, ar: 2 })).toBe("");
    for (const bad of ["", "nope", "[]", '{"x":0}', '{"x":0,"y":0,"w":0.5,"h":0.5,"ar":0}', '{"x":"0","y":0,"w":0.5,"h":0.5,"ar":1}', 3]) {
      expect(parseImageCrop(bad)).toBeNull();
    }
  });

  it("keep their edges inside the image", () => {
    expect(parseImageCrop(JSON.stringify({ x: 0.9, y: -1, w: 0.5, h: 0.001, ar: 1 }))).toEqual({ x: 0.5, y: 0, w: 0.5, h: MIN_CROP, ar: 1 });
    expect(clampCrop({ x: -0.2, y: 0.5, w: 2, h: 0.4, ar: 1 })).toEqual({ x: 0, y: 0.5, w: 1, h: 0.4, ar: 1 });
  });

  it("draw the part in a box of its shape", () => {
    const { box, image } = cropStyles(crop);
    // 1.5 × 0.5 / 0.4
    expect(box.aspectRatio).toBe("1.875");
    expect(image).toMatchObject({ width: "200%", height: "250%", left: "-20%", top: "-50%" });
    expect(cropCss({ maxWidth: "none", aspectRatio: "2" })).toBe("max-width:none;aspect-ratio:2");
  });

  it("move and resize by their handles, stopping at the image's edges", () => {
    expect(dragCrop(crop, "move", 0.8, -0.5)).toEqual({ ...crop, x: 0.5, y: 0 });
    const se = dragCrop(crop, "se", 0.1, 0.1);
    expect(se.x).toBe(0.1);
    expect(se.w).toBeCloseTo(0.6);
    expect(se.h).toBeCloseTo(0.5);
    const nw = dragCrop(crop, "nw", -1, 1);
    expect(nw).toMatchObject({ x: 0, w: 0.6 });
    expect(nw.h).toBeCloseTo(MIN_CROP);
    const e = dragCrop(crop, "e", 0, 1);
    expect(e.y).toBe(0.2);
    expect(e.h).toBeCloseTo(0.4);
  });

  it("come back to the images of the same file when Markdown is written back", () => {
    const value = formatImageCrop(crop);
    const existing = [
      { type: "image", props: { url: "/a.png", crop: value } },
      { type: "paragraph", props: {}, children: [{ type: "image", props: { url: "/b.png", crop: "" } }] },
    ];
    const blocks = [
      { type: "image", props: { url: "/b.png", crop: "" } },
      { type: "image", props: { url: "/a.png", crop: "" } },
      { type: "image", props: { url: "/a.png", crop: "" } },
    ];
    restoreImageCrops(blocks, existing);
    expect(blocks.map((b) => b.props.crop)).toEqual(["", value, ""]);
  });
});
