/**
 * @file manag.codes — the "Home" workspace.
 *
 * Upload clothing photos, cut their backgrounds out, arrange and resize the pieces on a
 * table, save looks to "My Outfits", build color palettes, and pick colors with the
 * color drop tool.
 *
 * The file has these parts:
 *   1. `Matting`     — pure image processing that removes a photo's background.
 *   2. Resize math   — pure geometry for proportional corner resizing.
 *   3. Color math    — pure hex/HSV conversion and color-wheel geometry.
 *   4. `Store`       — saving in the browser (IndexedDB), so refreshing loses nothing.
 *   5. The page controller — DOM wiring for the workspace, outfits, palettes, dialogs
 *      and tabs, plus saving and restoring what the user has made.
 */
(function () {
  'use strict';

  /* MATTING-START */

  /**
   * Background removal via alpha matting.
   *
   * Pipeline (see {@link computeMatte}):
   *  1. Find the "sure background": pixels connected to the image border that match the
   *     backdrop color (tight tolerance, so faint wisps and thin strands survive).
   *  2. Sweep up soft shadows, halos and floor patches that are just the backdrop made
   *     brighter or darker (smooth, same hue) without touching textured or colored fabric.
   *  3. Build a trimap: sure background, sure foreground (well inside the subject) and an
   *     unknown band along the edge.
   *  4. In the unknown band model every pixel as `C = a*F + (1-a)*B`. Test many nearby
   *     foreground/background color samples and keep the pair that explains the pixel
   *     best. That yields a soft alpha (hair, fringe, gradients) instead of a hard cut.
   *  5. Remove background tint from semi-transparent edge pixels and drop edge specks.
   *
   * @namespace Matting
   */
  const Matting = (function () {

    // ------------------------------------------------------------------ pixel layout

    /** Bytes per pixel in canvas ImageData (red, green, blue, alpha). */
    const BYTES_PER_PIXEL = 4;
    /** Number of color channels that take part in color math (red, green, blue). */
    const COLOR_CHANNELS = 3;
    /**
     * Position of each channel inside a pixel. The first three also index an `[r, g, b]`
     * color triple.
     */
    const OFFSET_RED = 0;
    const OFFSET_GREEN = 1;
    const OFFSET_BLUE = 2;
    const OFFSET_ALPHA = 3;
    /** Largest value of an 8-bit channel; also "fully opaque" for alpha. */
    const CHANNEL_MAX = 255;
    /** Format used when exporting the cut-out image (keeps transparency). */
    const OUTPUT_IMAGE_TYPE = 'image/png';
    /** A pixel has at most this many 4-connected neighbors (left, right, up, down). */
    const MAX_NEIGHBORS = 4;
    /** A band along the left/right (or top/bottom) edge exists on two opposite sides. */
    const OPPOSITE_SIDES = 2;
    /** A median sits halfway through the sorted values. */
    const MEDIAN_POSITION = 0.5;
    /** Weight of the center sample in a second difference: `before + after - 2 * center`. */
    const SECOND_DIFFERENCE_CENTER_WEIGHT = 2;
    /** One full turn in radians. */
    const FULL_TURN_RAD = 2 * Math.PI;

    // ---------------------------------------------------------------- tuning: overall

    /** Photos larger than this (longest side, px) are scaled down before processing. */
    const MAX_IMAGE_DIMENSION_PX = 900;
    /** Ignore background shares outside this range: nothing to cut, or nothing left. */
    const MIN_BACKGROUND_SHARE = 0.02;
    const MAX_BACKGROUND_SHARE = 0.995;

    // --------------------------------------------- tuning: reading the backdrop color

    /** The border is sampled roughly this many times per side. */
    const BORDER_SAMPLES_PER_SIDE = 100;
    /** Border pixels with alpha below this already count as transparent. */
    const TRANSPARENT_ALPHA_BELOW = 20;
    /** If more than this share of the border is transparent the photo is already cut out. */
    const MAX_TRANSPARENT_BORDER_SHARE = 0.5;
    /** Border samples within this color distance of the median form the backdrop. */
    const BORDER_CLUSTER_RADIUS = 45;
    /** At least this share of the border must form one cluster, else the photo is "busy". */
    const MIN_UNIFORM_BORDER_SHARE = 0.6;

    // ---------------------------------------------- tuning: sure background (flood)

    /** Max color distance from the (drifting) backdrop reference to count as backdrop. */
    const FLOOD_TOLERANCE = 20;
    /** How quickly the flood's reference color follows a gentle gradient (0..1). */
    const FLOOD_REFERENCE_DRIFT = 0.1;
    /** The reference color may never wander further than this from the true backdrop. */
    const FLOOD_MAX_REFERENCE_DRIFT = 28;

    // ------------------------------------------------ tuning: border artifact cleanup

    /** Width of the edge band checked for scan/crop lines: at least this many px... */
    const BORDER_BAND_MIN_PX = 3;
    /** ...or this fraction of the longest side, whichever is larger. */
    const BORDER_BAND_FRACTION = 0.006;
    /** Images must be wider/taller than the band doubled plus this margin to be cleaned. */
    const BORDER_CLEAN_MIN_INTERIOR_PX = 2;
    /** Extra px added to the band when deciding whether a speck "touches" the edge. */
    const EDGE_SPECK_EXTRA_MARGIN_PX = 2;
    /** Pixels with alpha at or below this are ignored when looking for specks. */
    const SPECK_MIN_ALPHA = 12;
    /** Edge-touching pieces smaller than this share of the largest piece are dropped. */
    const SPECK_MAX_SHARE_OF_LARGEST = 0.05;

    // --------------------------------- tuning: sweep 1 (gentle gradients near backdrop)

    /** Max color step between neighboring (blurred) pixels while sweeping. */
    const GRADIENT_SWEEP_SMOOTH_STEP = 9;
    /** Max color distance from the backdrop for a swept pixel. */
    const GRADIENT_SWEEP_MAX_DISTANCE = 48;
    /** Max color step between neighboring raw pixels (keeps thin strands protected). */
    const GRADIENT_SWEEP_RAW_STEP = 24;
    /** Discard the sweep if it would remove more than this share of what is left. */
    const GRADIENT_SWEEP_MAX_SHARE = 0.25;

    // ------------------------------------ tuning: sweep 2 (shadows and floor patches)

    /** A shadow/highlight is the backdrop color times a factor in this range. */
    const SHADOW_MIN_SCALE = 0.5;
    const SHADOW_MAX_SCALE = 1.25;
    /** Max distance between a pixel and the scaled backdrop color (i.e. hue mismatch). */
    const SHADOW_HUE_TOLERANCE = 10;
    /** Max color step between neighboring raw pixels while sweeping shadows. */
    const SHADOW_RAW_STEP = 22;
    /** Discard the shadow sweep if it would remove more than this share of what is left. */
    const SHADOW_SWEEP_MAX_SHARE = 0.5;
    /** Backdrop texture is measured on every Nth pixel to keep this cheap. */
    const TEXTURE_BASELINE_STRIDE = 7;
    /** Baseline texture assumed when no backdrop pixel could be sampled. */
    const TEXTURE_FALLBACK_BASELINE = 2;
    /** Smoothest allowed texture limit, and how many times the backdrop's own noise. */
    const TEXTURE_MIN_LIMIT = 3;
    const TEXTURE_LIMIT_FACTOR = 2.4;
    /** Texture window radius (window is 2r+1 wide) and second-difference spacing. */
    const TEXTURE_WINDOW_RADIUS = 3;
    const TEXTURE_SAMPLE_OFFSET = 2;
    /**
     * Second differences count double by definition (divide by 2) and the score averages
     * two axes (divide by 2 again).
     */
    const TEXTURE_NORMALIZER = 4;
    /** Rec. 601 luma weights used to turn a color into a brightness. */
    const LUMA_WEIGHT_RED = 0.299;
    const LUMA_WEIGHT_GREEN = 0.587;
    const LUMA_WEIGHT_BLUE = 0.114;
    /** Added regions narrower than 2r+1 px (trim, narrow stripes) are put back. */
    const OPENING_MIN_RADIUS_PX = 4;
    const OPENING_RADIUS_FRACTION = 0.006;

    // -------------------------------------------------------------- tuning: trimap

    /** Width of the unknown band along the subject edge: at least this many px... */
    const UNKNOWN_BAND_MIN_PX = 6;
    /** ...or this fraction of the longest side, whichever is larger. */
    const UNKNOWN_BAND_FRACTION = 0.018;

    // ------------------------------------------- tuning: sampling colors for the solve

    /** Sample rings around a pixel, as multiples of the unknown band width. */
    const SAMPLE_RING_SCALES = Object.freeze([0.5, 1, 1.6, 2.4]);
    const SAMPLE_RING_MIN_RADIUS_PX = 2;
    const SAMPLES_PER_RING = 8;
    /** Each ring is rotated a little so samples don't line up across rings. */
    const SAMPLE_RING_TWIST_RAD = 0.4;
    /** Foreground/background samples kept per pixel. */
    const MAX_CANDIDATES = 10;

    // ---------------------------------------------------------- tuning: alpha solve

    /** If F and B are this close (squared distance) alpha cannot be projected reliably. */
    const NEAR_IDENTICAL_COLORS_SQ = 400;
    /** Cost per pixel of distance between a pixel and its F/B color samples. */
    const SAMPLE_DISTANCE_PENALTY = 0.6;
    /** Avoids dividing by zero. */
    const EPSILON = 1e-6;
    /** Alpha below/above these snaps to fully transparent/opaque (removes speckle). */
    const ALPHA_SNAP_TRANSPARENT = 0.03;
    const ALPHA_SNAP_OPAQUE = 0.86;
    /** Below this alpha the decontaminated color is noisy, so blend toward the sample. */
    const DECONTAMINATE_TRUST_ALPHA = 0.2;

    // ------------------------------------------- tuning: color-to-alpha (smoke, mist)

    /** A pixel this close to the backdrop is treated as backdrop. */
    const COLOR_TO_ALPHA_BACKDROP_DISTANCE = 3;
    /** Fixed cost of this hypothesis, so real F/B samples win when one is nearby. */
    const COLOR_TO_ALPHA_PENALTY = 20;
    /** Largest foreground "boost" tried (alpha can go down to 1/this). */
    const COLOR_TO_ALPHA_MAX_SCALE = 8;
    /** Channel differences smaller than this are ignored when finding the boost limit. */
    const COLOR_TO_ALPHA_MIN_CHANNEL_DELTA = 0.5;

    // ------------------------------------------------------------- small helpers

    /**
     * Euclidean distance between two RGB colors.
     * @param {number} r1 @param {number} g1 @param {number} b1 First color.
     * @param {number} r2 @param {number} g2 @param {number} b2 Second color.
     * @returns {number}
     */
    function colorDistance(r1, g1, b1, r2, g2, b2) {
      const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
      return Math.sqrt(dr * dr + dg * dg + db * db);
    }

    /**
     * Distance between an RGB color and a reference color triple.
     * @param {number} r @param {number} g @param {number} b The color.
     * @param {number[]} color Reference `[r, g, b]`.
     * @returns {number}
     */
    function distanceToTriple(r, g, b, color) {
      return colorDistance(r, g, b, color[OFFSET_RED], color[OFFSET_GREEN], color[OFFSET_BLUE]);
    }

    /**
     * Dot product of an RGB color with a reference color triple.
     * @param {number} r @param {number} g @param {number} b The color.
     * @param {number[]} color Reference `[r, g, b]`.
     * @returns {number}
     */
    function dotWithTriple(r, g, b, color) {
      return r * color[OFFSET_RED] + g * color[OFFSET_GREEN] + b * color[OFFSET_BLUE];
    }

    /**
     * Color distance between the pixel at byte index `ia` of `bufA` and the pixel at `ib`
     * of `bufB`.
     * @param {Uint8ClampedArray} bufA @param {number} ia
     * @param {Uint8ClampedArray} bufB @param {number} ib
     * @returns {number}
     */
    function pixelDistance(bufA, ia, bufB, ib) {
      return colorDistance(
        bufA[ia + OFFSET_RED], bufA[ia + OFFSET_GREEN], bufA[ia + OFFSET_BLUE],
        bufB[ib + OFFSET_RED], bufB[ib + OFFSET_GREEN], bufB[ib + OFFSET_BLUE]);
    }

    /**
     * Color distance between the pixel at byte index `i` of `buf` and a reference color.
     * @param {Uint8ClampedArray} buf @param {number} i @param {number[]} color `[r, g, b]`
     * @returns {number}
     */
    function distanceToColor(buf, i, color) {
      return colorDistance(
        buf[i + OFFSET_RED], buf[i + OFFSET_GREEN], buf[i + OFFSET_BLUE],
        color[OFFSET_RED], color[OFFSET_GREEN], color[OFFSET_BLUE]);
    }

    /**
     * Clamps a value to the 0..255 channel range.
     * @param {number} v @returns {number}
     */
    function clampChannel(v) {
      return v < 0 ? 0 : v > CHANNEL_MAX ? CHANNEL_MAX : v;
    }

    /** Scratch space for {@link collectNeighbors}; safe because callers never nest. */
    const neighborScratch = new Int32Array(MAX_NEIGHBORS);

    /**
     * Fills `neighborScratch` with the 4-connected neighbors of pixel `p` (left, right,
     * up, down) that lie inside the image.
     * @param {number} p Pixel index. @param {number} w Width. @param {number} h Height.
     * @returns {number} How many neighbors were written.
     */
    function collectNeighbors(p, w, h) {
      const x = p % w, y = Math.floor(p / w);
      let count = 0;
      if (x > 0) neighborScratch[count++] = p - 1;
      if (x < w - 1) neighborScratch[count++] = p + 1;
      if (y > 0) neighborScratch[count++] = p - w;
      if (y < h - 1) neighborScratch[count++] = p + w;
      return count;
    }

    /**
     * Width of the strip along the image edge that is inspected for border artifacts.
     * @param {number} w @param {number} h @returns {number} Pixels.
     */
    function borderBandWidth(w, h) {
      return Math.max(BORDER_BAND_MIN_PX, Math.round(Math.max(w, h) * BORDER_BAND_FRACTION));
    }

    /**
     * Counts the set pixels of a binary mask.
     * @param {Uint8Array} mask @returns {number}
     */
    function countSet(mask) {
      let total = 0;
      for (let p = 0; p < mask.length; p++) total += mask[p];
      return total;
    }

    // ------------------------------------------------------------ backdrop analysis

    /**
     * Estimates the backdrop color from the image border.
     *
     * @param {Uint8ClampedArray} data RGBA pixels.
     * @param {number} w Width. @param {number} h Height.
     * @returns {number[]|null} `[r, g, b]`, or `null` when the photo should be left alone
     *   (already transparent, or the border is too varied to be a plain backdrop).
     */
    function estimateBackground(data, w, h) {
      const step = Math.max(1, Math.floor(Math.min(w, h) / BORDER_SAMPLES_PER_SIDE));
      const reds = [], greens = [], blues = [];
      let total = 0, transparent = 0;

      const addSample = (x, y) => {
        const i = (y * w + x) * BYTES_PER_PIXEL;
        total++;
        if (data[i + OFFSET_ALPHA] < TRANSPARENT_ALPHA_BELOW) { transparent++; return; }
        reds.push(data[i + OFFSET_RED]);
        greens.push(data[i + OFFSET_GREEN]);
        blues.push(data[i + OFFSET_BLUE]);
      };
      for (let x = 0; x < w; x += step) { addSample(x, 0); addSample(x, h - 1); }
      for (let y = 0; y < h; y += step) { addSample(0, y); addSample(w - 1, y); }

      if (transparent > total * MAX_TRANSPARENT_BORDER_SHARE || reds.length === 0) return null;

      const median = values => {
        const sorted = values.slice().sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * MEDIAN_POSITION)];
      };
      const center = [median(reds), median(greens), median(blues)];

      let inCluster = 0, sumR = 0, sumG = 0, sumB = 0;
      for (let k = 0; k < reds.length; k++) {
        if (distanceToTriple(reds[k], greens[k], blues[k], center) < BORDER_CLUSTER_RADIUS) {
          inCluster++; sumR += reds[k]; sumG += greens[k]; sumB += blues[k];
        }
      }
      if (inCluster < reds.length * MIN_UNIFORM_BORDER_SHARE) return null;
      return [sumR / inCluster, sumG / inCluster, sumB / inCluster];
    }

    /**
     * Paints over a thin dark/light line along an image edge (a crop or scan artifact).
     * Only edge strips whose neighbors just inside are plain backdrop are touched, so a
     * subject that reaches the edge is never smeared.
     *
     * @param {Uint8ClampedArray} data RGBA pixels, modified in place.
     * @param {number} w @param {number} h @param {number[]} background `[r, g, b]`
     * @returns {void}
     */
    function cleanBorder(data, w, h, background) {
      const band = borderBandWidth(w, h);
      if (w <= band * OPPOSITE_SIDES + BORDER_CLEAN_MIN_INTERIOR_PX ||
          h <= band * OPPOSITE_SIDES + BORDER_CLEAN_MIN_INTERIOR_PX) return;

      const isBackdrop = p =>
        distanceToColor(data, p * BYTES_PER_PIXEL, background) <= FLOOD_TOLERANCE;
      const copyPixel = (from, to) => {
        const f = from * BYTES_PER_PIXEL, t = to * BYTES_PER_PIXEL;
        data[t + OFFSET_RED] = data[f + OFFSET_RED];
        data[t + OFFSET_GREEN] = data[f + OFFSET_GREEN];
        data[t + OFFSET_BLUE] = data[f + OFFSET_BLUE];
        data[t + OFFSET_ALPHA] = CHANNEL_MAX;
      };

      for (let y = 0; y < h; y++) {
        const innerLeft = y * w + band, innerRight = y * w + (w - 1 - band);
        if (isBackdrop(innerLeft)) for (let x = 0; x < band; x++) copyPixel(innerLeft, y * w + x);
        if (isBackdrop(innerRight)) for (let x = w - band; x < w; x++) copyPixel(innerRight, y * w + x);
      }
      for (let x = 0; x < w; x++) {
        const innerTop = band * w + x, innerBottom = (h - 1 - band) * w + x;
        if (isBackdrop(innerTop)) for (let y = 0; y < band; y++) copyPixel(innerTop, y * w + x);
        if (isBackdrop(innerBottom)) for (let y = h - band; y < h; y++) copyPixel(innerBottom, y * w + x);
      }
    }

    /**
     * Returns a 3x3 box-blurred copy of the image (alpha forced opaque). Used for stable
     * color sampling and for judging smoothness, never for the final pixels.
     *
     * @param {Uint8ClampedArray} src RGBA pixels. @param {number} w @param {number} h
     * @returns {Uint8ClampedArray}
     */
    function boxBlur(src, w, h) {
      const out = new Uint8ClampedArray(src.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0, samples = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              const i = (yy * w + xx) * BYTES_PER_PIXEL;
              r += src[i + OFFSET_RED]; g += src[i + OFFSET_GREEN]; b += src[i + OFFSET_BLUE];
              samples++;
            }
          }
          const o = (y * w + x) * BYTES_PER_PIXEL;
          out[o + OFFSET_RED] = r / samples;
          out[o + OFFSET_GREEN] = g / samples;
          out[o + OFFSET_BLUE] = b / samples;
          out[o + OFFSET_ALPHA] = CHANNEL_MAX;
        }
      }
      return out;
    }

    // ---------------------------------------------------------- sure background mask

    /**
     * Flood-fills the sure-background mask inward from the image border. The color the
     * fill compares against drifts slowly (but only up to a limit) so gentle gradients
     * in the backdrop are followed while real edges stop the fill.
     *
     * @param {Uint8ClampedArray} data RGBA pixels. @param {number} w @param {number} h
     * @param {number[]} background `[r, g, b]` backdrop color.
     * @returns {Uint8Array} Mask, 1 where the pixel is backdrop.
     */
    function floodBackground(data, w, h, background) {
      const n = w * h;
      const mask = new Uint8Array(n);
      const references = new Float32Array(n * COLOR_CHANNELS);
      const queue = new Int32Array(n);
      let head = 0, tail = 0;

      /** Adds pixel `p` if it matches the reference color inherited from its parent. */
      const tryAdd = (p, refR, refG, refB) => {
        if (mask[p]) return;
        const i = p * BYTES_PER_PIXEL;
        const r = data[i + OFFSET_RED], g = data[i + OFFSET_GREEN], b = data[i + OFFSET_BLUE];
        const toReference = colorDistance(r, g, b, refR, refG, refB);
        const toBackdrop = distanceToTriple(r, g, b, background);
        if (Math.min(toReference, toBackdrop) > FLOOD_TOLERANCE) return;
        mask[p] = 1;

        // Nudge the reference toward this pixel, but never far from the true backdrop.
        let nextR = refR + (r - refR) * FLOOD_REFERENCE_DRIFT;
        let nextG = refG + (g - refG) * FLOOD_REFERENCE_DRIFT;
        let nextB = refB + (b - refB) * FLOOD_REFERENCE_DRIFT;
        const drift = distanceToTriple(nextR, nextG, nextB, background);
        if (drift > FLOOD_MAX_REFERENCE_DRIFT) {
          const pullBack = FLOOD_MAX_REFERENCE_DRIFT / drift;
          nextR = background[OFFSET_RED] + (nextR - background[OFFSET_RED]) * pullBack;
          nextG = background[OFFSET_GREEN] + (nextG - background[OFFSET_GREEN]) * pullBack;
          nextB = background[OFFSET_BLUE] + (nextB - background[OFFSET_BLUE]) * pullBack;
        }
        const ref = p * COLOR_CHANNELS;
        references[ref + OFFSET_RED] = nextR;
        references[ref + OFFSET_GREEN] = nextG;
        references[ref + OFFSET_BLUE] = nextB;
        queue[tail++] = p;
      };

      // Seed from every border pixel using the true backdrop color as the reference.
      for (let x = 0; x < w; x++) {
        tryAdd(x, background[OFFSET_RED], background[OFFSET_GREEN], background[OFFSET_BLUE]);
        tryAdd((h - 1) * w + x, background[OFFSET_RED], background[OFFSET_GREEN], background[OFFSET_BLUE]);
      }
      for (let y = 0; y < h; y++) {
        tryAdd(y * w, background[OFFSET_RED], background[OFFSET_GREEN], background[OFFSET_BLUE]);
        tryAdd(y * w + w - 1, background[OFFSET_RED], background[OFFSET_GREEN], background[OFFSET_BLUE]);
      }

      while (head < tail) {
        const p = queue[head++];
        const ref = p * COLOR_CHANNELS;
        const refR = references[ref + OFFSET_RED];
        const refG = references[ref + OFFSET_GREEN];
        const refB = references[ref + OFFSET_BLUE];
        const count = collectNeighbors(p, w, h);
        for (let k = 0; k < count; k++) tryAdd(neighborScratch[k], refR, refG, refB);
      }
      return mask;
    }

    /**
     * Grows a mask outward through neighboring pixels that pass `test`.
     *
     * @param {Uint8Array} mask Starting mask (not modified).
     * @param {number} w @param {number} h
     * @param {(fromByteIndex: number, toByteIndex: number) => boolean} test Decides whether
     *   the mask may spread from one pixel to a neighbor (arguments are byte indices).
     * @returns {{grown: Uint8Array, added: number}} The new mask and how many pixels it gained.
     */
    function growMask(mask, w, h, test) {
      const n = w * h;
      const grown = mask.slice();
      const queue = new Int32Array(n);
      let head = 0, tail = 0, added = 0;

      // Start from mask pixels that touch a pixel outside the mask.
      for (let p = 0; p < n; p++) {
        if (!mask[p]) continue;
        const count = collectNeighbors(p, w, h);
        for (let k = 0; k < count; k++) {
          if (!mask[neighborScratch[k]]) { queue[tail++] = p; break; }
        }
      }

      while (head < tail) {
        const p = queue[head++];
        const count = collectNeighbors(p, w, h);
        for (let k = 0; k < count; k++) {
          const q = neighborScratch[k];
          if (grown[q] || !test(p * BYTES_PER_PIXEL, q * BYTES_PER_PIXEL)) continue;
          grown[q] = 1; added++;
          queue[tail++] = q;
        }
      }
      return { grown, added };
    }

    /**
     * Sweep 1: spreads the background mask through smooth pixels that are close to the
     * backdrop color (gentle gradients). Skipped if it would remove too much of the rest.
     *
     * @param {{data: Uint8ClampedArray, smoothed: Uint8ClampedArray, w: number, h: number,
     *   background: number[]}} img Analysis inputs.
     * @param {Uint8Array} mask Current background mask.
     * @returns {Uint8Array} The (possibly grown) mask.
     */
    function sweepGradients(img, mask) {
      const { data, smoothed, w, h, background } = img;
      const test = (from, to) =>
        pixelDistance(smoothed, from, smoothed, to) <= GRADIENT_SWEEP_SMOOTH_STEP &&
        distanceToColor(smoothed, to, background) <= GRADIENT_SWEEP_MAX_DISTANCE &&
        pixelDistance(data, from, data, to) <= GRADIENT_SWEEP_RAW_STEP;

      const remaining = w * h - countSet(mask);
      const { grown, added } = growMask(mask, w, h, test);
      return added <= remaining * GRADIENT_SWEEP_MAX_SHARE ? grown : mask;
    }

    /**
     * Local texture score for every pixel: the average small-scale curvature of brightness
     * over a window. A studio backdrop or soft shadow is smooth (score ≈ image noise, even
     * on a steep gradient); knit, denim and leather have weave/grain and score higher.
     *
     * @param {Uint8ClampedArray} data RGBA pixels. @param {number} w @param {number} h
     * @returns {Float32Array} One score per pixel.
     */
    function textureMap(data, w, h) {
      const n = w * h;
      const luma = new Float32Array(n);
      for (let p = 0; p < n; p++) {
        const i = p * BYTES_PER_PIXEL;
        luma[p] = LUMA_WEIGHT_RED * data[i + OFFSET_RED] +
                  LUMA_WEIGHT_GREEN * data[i + OFFSET_GREEN] +
                  LUMA_WEIGHT_BLUE * data[i + OFFSET_BLUE];
      }

      // Second difference along both axes: zero on a smooth ramp, large for grain.
      const curvature = new Float32Array(n);
      const reach = TEXTURE_SAMPLE_OFFSET;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          const right = x + reach < w ? p + reach : p;
          const left = x - reach >= 0 ? p - reach : p;
          const down = y + reach < h ? p + reach * w : p;
          const up = y - reach >= 0 ? p - reach * w : p;
          const center = SECOND_DIFFERENCE_CENTER_WEIGHT * luma[p];
          curvature[p] = (Math.abs(luma[right] + luma[left] - center) +
                          Math.abs(luma[down] + luma[up] - center)) / TEXTURE_NORMALIZER;
        }
      }

      // Window average via an integral image (summed-area table).
      const stride = w + 1;
      const integral = new Float64Array(stride * (h + 1));
      for (let y = 0; y < h; y++) {
        let rowSum = 0;
        for (let x = 0; x < w; x++) {
          rowSum += curvature[y * w + x];
          integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
        }
      }
      const texture = new Float32Array(n);
      const r = TEXTURE_WINDOW_RADIUS;
      for (let y = 0; y < h; y++) {
        const top = Math.max(0, y - r), bottom = Math.min(h, y + r + 1);
        for (let x = 0; x < w; x++) {
          const left = Math.max(0, x - r), right = Math.min(w, x + r + 1);
          const sum = integral[bottom * stride + right] - integral[top * stride + right] -
                      integral[bottom * stride + left] + integral[top * stride + left];
          texture[y * w + x] = sum / ((bottom - top) * (right - left));
        }
      }
      return texture;
    }

    /**
     * Morphological opening of a binary mask with a square of side `2*radius + 1`: erases
     * parts thinner than the square (trim, narrow stripes) and keeps wide regions
     * (shadows, floor patches). Outside the image counts as "set" while eroding so
     * regions touching the edge are not shaved.
     *
     * @param {Uint8Array} mask @param {number} w @param {number} h @param {number} radius
     * @returns {Uint8Array} The opened mask.
     */
    function openMask(mask, w, h, radius) {
      const n = w * h;

      /** One separable pass: sliding min (erode) or max (dilate) along rows or columns. */
      const pass = (src, horizontal, erode) => {
        const out = new Uint8Array(n);
        const length = horizontal ? w : h;
        const lines = horizontal ? h : w;
        for (let line = 0; line < lines; line++) {
          for (let i = 0; i < length; i++) {
            let result = erode ? 1 : 0;
            for (let k = -radius; k <= radius; k++) {
              const j = i + k;
              let value;
              if (j < 0 || j >= length) value = erode ? 1 : 0;
              else value = src[horizontal ? line * w + j : j * w + line];
              if (erode && !value) { result = 0; break; }
              if (!erode && value) { result = 1; break; }
            }
            out[horizontal ? line * w + i : i * w + line] = result;
          }
        }
        return out;
      };

      const eroded = pass(pass(mask, true, true), false, true);
      return pass(pass(eroded, true, false), false, false);
    }

    /**
     * Sweep 2: spreads the background mask through shadows and floor patches. A shadow is
     * the backdrop color scaled darker (or a highlight scaled lighter): same hue, any
     * brightness, and as smooth as the backdrop. Garments fail at least one of those —
     * colored fabric has a different hue, knit and leather have texture — and narrow
     * regions (trim, stripes) are put back afterwards.
     *
     * @param {{data: Uint8ClampedArray, smoothed: Uint8ClampedArray, w: number, h: number,
     *   background: number[]}} img Analysis inputs.
     * @param {Uint8Array} mask Current background mask (modified in place when accepted).
     * @returns {Uint8Array} The resulting mask (same array as `mask`).
     */
    function sweepShadows(img, mask) {
      const { data, smoothed, w, h, background } = img;
      const n = w * h;
      const backgroundNormSq = dotWithTriple(
        background[OFFSET_RED], background[OFFSET_GREEN], background[OFFSET_BLUE], background) || 1;

      // The backdrop's own noise sets how much texture still counts as "smooth".
      const texture = textureMap(data, w, h);
      const baselineSamples = [];
      for (let p = 0; p < n; p += TEXTURE_BASELINE_STRIDE) {
        if (mask[p]) baselineSamples.push(texture[p]);
      }
      baselineSamples.sort((a, b) => a - b);
      const baseline = baselineSamples.length
        ? baselineSamples[Math.floor(baselineSamples.length * MEDIAN_POSITION)]
        : TEXTURE_FALLBACK_BASELINE;
      const textureLimit = Math.max(TEXTURE_MIN_LIMIT, TEXTURE_LIMIT_FACTOR * baseline);

      const test = (from, to) => {
        if (texture[to / BYTES_PER_PIXEL] > textureLimit) return false;
        const r = smoothed[to + OFFSET_RED];
        const g = smoothed[to + OFFSET_GREEN];
        const b = smoothed[to + OFFSET_BLUE];
        // Project the pixel onto the backdrop color to get the brightness scale.
        const scale = dotWithTriple(r, g, b, background) / backgroundNormSq;
        if (scale < SHADOW_MIN_SCALE || scale > SHADOW_MAX_SCALE) return false;
        const hueMismatch = colorDistance(
          r, g, b,
          scale * background[OFFSET_RED], scale * background[OFFSET_GREEN], scale * background[OFFSET_BLUE]);
        if (hueMismatch > SHADOW_HUE_TOLERANCE) return false;
        // Raw pixels (not blurred) for the edge step so thin strands stay protected.
        return pixelDistance(data, from, data, to) <= SHADOW_RAW_STEP;
      };

      const remaining = n - countSet(mask);
      const { grown, added } = growMask(mask, w, h, test);
      if (added === 0) return mask;

      // Keep only the wide parts of what was added.
      const addedMask = new Uint8Array(n);
      for (let p = 0; p < n; p++) if (grown[p] && !mask[p]) addedMask[p] = 1;
      const radius = Math.max(OPENING_MIN_RADIUS_PX,
                              Math.round(Math.max(w, h) * OPENING_RADIUS_FRACTION));
      const kept = openMask(addedMask, w, h, radius);
      if (countSet(kept) > remaining * SHADOW_SWEEP_MAX_SHARE) return mask;

      for (let p = 0; p < n; p++) if (kept[p]) mask[p] = 1;
      return mask;
    }

    // --------------------------------------------------------------------- trimap

    /**
     * For every pixel: distance to, and index of, the nearest set pixel of `mask`
     * (approximate Euclidean distance transform with two sweeps).
     *
     * @param {Uint8Array} mask Source pixels. @param {number} w @param {number} h
     * @returns {{d: Float32Array, src: Int32Array}} Distance and source index per pixel
     *   (`-1` when no source exists).
     */
    function nearestSource(mask, w, h) {
      const n = w * h;
      const d = new Float32Array(n).fill(Infinity);
      const src = new Int32Array(n).fill(-1);
      for (let p = 0; p < n; p++) if (mask[p]) { d[p] = 0; src[p] = p; }

      /** Neighbors already visited by a top-left → bottom-right sweep: W, N, NW, NE. */
      const FORWARD = [[-1, 0], [0, -1], [-1, -1], [1, -1]];
      /** Neighbors already visited by a bottom-right → top-left sweep: E, S, SE, SW. */
      const BACKWARD = [[1, 0], [0, 1], [1, 1], [-1, 1]];

      const relax = (p, x, y, neighbors) => {
        for (let k = 0; k < neighbors.length; k++) {
          const nx = x + neighbors[k][0], ny = y + neighbors[k][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const source = src[ny * w + nx];
          if (source < 0) continue;
          const dx = x - (source % w), dy = y - Math.floor(source / w);
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < d[p]) { d[p] = distance; src[p] = source; }
        }
      };

      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) relax(y * w + x, x, y, FORWARD);
      for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) relax(y * w + x, x, y, BACKWARD);
      return { d, src };
    }

    /**
     * Builds the trimap: sure background, sure foreground (further than the unknown band
     * from any background) and the unknown band in between, plus nearest-sample maps.
     *
     * @param {Uint8Array} bgMask Sure-background mask. @param {number} w @param {number} h
     * @returns {{bgMask: Uint8Array, fgMask: Uint8Array,
     *   toBG: {d: Float32Array, src: Int32Array}, toFG: {d: Float32Array, src: Int32Array},
     *   bandWidth: number}}
     */
    function buildTrimap(bgMask, w, h) {
      const n = w * h;
      const toBG = nearestSource(bgMask, w, h);
      const bandWidth = Math.max(UNKNOWN_BAND_MIN_PX,
                                 Math.round(Math.max(w, h) * UNKNOWN_BAND_FRACTION));

      const fgMask = new Uint8Array(n);
      let fgCount = 0;
      for (let p = 0; p < n; p++) {
        if (!bgMask[p] && toBG.d[p] > bandWidth) { fgMask[p] = 1; fgCount++; }
      }
      if (fgCount === 0) {
        // Tiny subject: treat everything that isn't background as solid.
        for (let p = 0; p < n; p++) if (!bgMask[p]) fgMask[p] = 1;
      }
      return { bgMask, fgMask, toBG, toFG: nearestSource(fgMask, w, h), bandWidth };
    }

    // ---------------------------------------------------------- alpha solve (per pixel)

    /**
     * Offsets of the pixels sampled around an unknown pixel: several rings at growing
     * radii, each slightly rotated.
     *
     * @param {number} bandWidth Unknown band width in px.
     * @returns {number[][]} List of `[dx, dy]`.
     */
    function buildSampleOffsets(bandWidth) {
      const offsets = [];
      SAMPLE_RING_SCALES.forEach((scale, ring) => {
        const radius = Math.max(SAMPLE_RING_MIN_RADIUS_PX, Math.round(bandWidth * scale));
        for (let k = 0; k < SAMPLES_PER_RING; k++) {
          const angle = k * (FULL_TURN_RAD / SAMPLES_PER_RING) + ring * SAMPLE_RING_TWIST_RAD;
          offsets.push([Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)]);
        }
      });
      return offsets;
    }

    /**
     * Allocates the reusable buffer of foreground/background sample candidates.
     * @returns {{fgIndex: Int32Array, bgIndex: Int32Array, fgDist: Float32Array,
     *   bgDist: Float32Array, fgCount: number, bgCount: number}}
     */
    function createCandidateBuffer() {
      return {
        fgIndex: new Int32Array(MAX_CANDIDATES), bgIndex: new Int32Array(MAX_CANDIDATES),
        fgDist: new Float32Array(MAX_CANDIDATES), bgDist: new Float32Array(MAX_CANDIDATES),
        fgCount: 0, bgCount: 0
      };
    }

    /**
     * Collects foreground and background color-sample candidates for unknown pixel `p`:
     * its nearest sure-foreground/background pixels plus samples on the surrounding rings.
     *
     * @param {number} p Pixel index. @param {number} w @param {number} h
     * @param {ReturnType<typeof buildTrimap>} trimap
     * @param {number[][]} offsets From {@link buildSampleOffsets}.
     * @param {ReturnType<typeof createCandidateBuffer>} cand Buffer to fill.
     * @returns {void}
     */
    function gatherCandidates(p, w, h, trimap, offsets, cand) {
      const { fgMask, bgMask, toFG, toBG } = trimap;
      cand.fgCount = 0; cand.bgCount = 0;
      if (toFG.src[p] >= 0) {
        cand.fgIndex[cand.fgCount] = toFG.src[p];
        cand.fgDist[cand.fgCount++] = toFG.d[p];
      }
      if (toBG.src[p] >= 0) {
        cand.bgIndex[cand.bgCount] = toBG.src[p];
        cand.bgDist[cand.bgCount++] = toBG.d[p];
      }

      const x = p % w, y = Math.floor(p / w);
      for (let k = 0; k < offsets.length &&
                      (cand.fgCount < MAX_CANDIDATES || cand.bgCount < MAX_CANDIDATES); k++) {
        const sx = x + offsets[k][0], sy = y + offsets[k][1];
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const q = sy * w + sx;
        const distance = Math.sqrt(offsets[k][0] * offsets[k][0] + offsets[k][1] * offsets[k][1]);
        if (fgMask[q] && cand.fgCount < MAX_CANDIDATES) {
          cand.fgIndex[cand.fgCount] = q; cand.fgDist[cand.fgCount++] = distance;
        } else if (bgMask[q] && cand.bgCount < MAX_CANDIDATES) {
          cand.bgIndex[cand.bgCount] = q; cand.bgDist[cand.bgCount++] = distance;
        }
      }
    }

    /**
     * Tries every foreground/background candidate pair and records the one that best
     * explains the pixel color under `C = a*F + (1-a)*B` (with a small penalty for
     * distant samples). Writes the winner into `fit`.
     *
     * @param {Uint8ClampedArray} smoothed Blurred image used for sample colors.
     * @param {number[]} color The pixel's own `[r, g, b]`.
     * @param {ReturnType<typeof createCandidateBuffer>} cand Candidates.
     * @param {{cost: number, alpha: number, fg: number[], bg: number[]}} fit Updated in place.
     * @returns {void}
     */
    function findBestPair(smoothed, color, cand, fit) {
      const [cr, cg, cb] = color;
      for (let fi = 0; fi < cand.fgCount; fi++) {
        const fo = cand.fgIndex[fi] * BYTES_PER_PIXEL;
        const fr = smoothed[fo + OFFSET_RED];
        const fg = smoothed[fo + OFFSET_GREEN];
        const fb = smoothed[fo + OFFSET_BLUE];
        for (let bi = 0; bi < cand.bgCount; bi++) {
          const bo = cand.bgIndex[bi] * BYTES_PER_PIXEL;
          const br = smoothed[bo + OFFSET_RED];
          const bg = smoothed[bo + OFFSET_GREEN];
          const bb = smoothed[bo + OFFSET_BLUE];

          // Project the pixel onto the line from B to F to get alpha.
          const vr = fr - br, vg = fg - bg, vb = fb - bb;
          const lengthSq = vr * vr + vg * vg + vb * vb;
          let alpha;
          if (lengthSq < NEAR_IDENTICAL_COLORS_SQ) {
            // F ≈ B: projection is unstable, fall back to relative closeness.
            const toB = colorDistance(cr, cg, cb, br, bg, bb);
            const toF = colorDistance(cr, cg, cb, fr, fg, fb);
            alpha = toB / (toB + toF + EPSILON);
          } else {
            alpha = ((cr - br) * vr + (cg - bg) * vg + (cb - bb) * vb) / lengthSq;
            alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
          }

          const residual = colorDistance(
            alpha * fr + (1 - alpha) * br, alpha * fg + (1 - alpha) * bg,
            alpha * fb + (1 - alpha) * bb, cr, cg, cb);
          const cost = residual + SAMPLE_DISTANCE_PENALTY * (cand.fgDist[fi] + cand.bgDist[bi]);
          if (cost < fit.cost) {
            fit.cost = cost; fit.alpha = alpha;
            fit.fg = [fr, fg, fb]; fit.bg = [br, bg, bb];
          }
        }
      }
    }

    /**
     * "Color-to-alpha" hypothesis for wisps with no solid foreground nearby (smoke, mist):
     * assume the most saturated foreground color that still explains the pixel, which gives
     * the smallest alpha that reproduces the same look. Replaces `fit` when it is cheaper.
     *
     * @param {Uint8ClampedArray} smoothed Blurred image used for sample colors.
     * @param {number[]} color The pixel's own `[r, g, b]`.
     * @param {ReturnType<typeof createCandidateBuffer>} cand Candidates (nearest background used).
     * @param {{cost: number, alpha: number, fg: number[], bg: number[]}} fit Updated in place.
     * @returns {void}
     */
    function tryColorToAlpha(smoothed, color, cand, fit) {
      const [cr, cg, cb] = color;
      const bo = cand.bgIndex[0] * BYTES_PER_PIXEL;
      const br = smoothed[bo + OFFSET_RED], bg = smoothed[bo + OFFSET_GREEN], bb = smoothed[bo + OFFSET_BLUE];
      const dr = cr - br, dg = cg - bg, db = cb - bb;

      if (Math.sqrt(dr * dr + dg * dg + db * db) < COLOR_TO_ALPHA_BACKDROP_DISTANCE) {
        // Essentially backdrop: transparent, unless a real sample explained it better.
        if (fit.cost > COLOR_TO_ALPHA_PENALTY) { fit.cost = 0; fit.alpha = 0; }
        return;
      }

      // Largest factor by which the difference from B can be boosted before a channel
      // leaves the 0..255 range.
      const limit = (delta, base) =>
        delta > COLOR_TO_ALPHA_MIN_CHANNEL_DELTA ? (CHANNEL_MAX - base) / delta :
        delta < -COLOR_TO_ALPHA_MIN_CHANNEL_DELTA ? base / -delta : Infinity;
      const boost = Math.min(COLOR_TO_ALPHA_MAX_SCALE, limit(dr, br), limit(dg, bg), limit(db, bb));
      const cost = SAMPLE_DISTANCE_PENALTY * cand.bgDist[0] + COLOR_TO_ALPHA_PENALTY;
      if (boost >= 1 && cost < fit.cost) {
        fit.cost = cost; fit.alpha = 1 / boost;
        fit.fg = [br + dr * boost, bg + dg * boost, bb + db * boost];
        fit.bg = [br, bg, bb];
      }
    }

    /**
     * Writes the solved alpha (and a decontaminated color) into pixel `i`.
     *
     * @param {Uint8ClampedArray} data RGBA pixels, modified in place.
     * @param {number} i Byte index of the pixel.
     * @param {number[]} color The pixel's original `[r, g, b]`.
     * @param {{alpha: number, fg: number[], bg: number[]}} fit The chosen fit.
     * @returns {void}
     */
    function writePixel(data, i, color, fit) {
      let alpha = fit.alpha;
      if (alpha < ALPHA_SNAP_TRANSPARENT) alpha = 0;
      else if (alpha > ALPHA_SNAP_OPAQUE) alpha = 1;

      if (alpha > 0 && alpha < 1) {
        // Undo the background's contribution: C = a*F + (1-a)*B  =>  F = (C - (1-a)*B) / a
        const channels = [0, 0, 0];
        for (let c = 0; c < COLOR_CHANNELS; c++) {
          channels[c] = (color[c] - (1 - alpha) * fit.bg[c]) / alpha;
        }
        if (alpha < DECONTAMINATE_TRUST_ALPHA) {
          // Too noisy to trust: lean on the sampled foreground color.
          const trust = alpha / DECONTAMINATE_TRUST_ALPHA;
          for (let c = 0; c < COLOR_CHANNELS; c++) {
            channels[c] = fit.fg[c] * (1 - trust) + channels[c] * trust;
          }
        }
        data[i + OFFSET_RED] = clampChannel(channels[OFFSET_RED]);
        data[i + OFFSET_GREEN] = clampChannel(channels[OFFSET_GREEN]);
        data[i + OFFSET_BLUE] = clampChannel(channels[OFFSET_BLUE]);
      }
      data[i + OFFSET_ALPHA] = Math.min(data[i + OFFSET_ALPHA], Math.round(alpha * CHANNEL_MAX));
    }

    /**
     * Solves alpha for every pixel of the trimap's unknown band (and clears sure
     * background). Sure foreground pixels are left untouched.
     *
     * @param {{data: Uint8ClampedArray, smoothed: Uint8ClampedArray, w: number, h: number,
     *   background: number[]}} img Analysis inputs; `data` is modified in place.
     * @param {ReturnType<typeof buildTrimap>} trimap
     * @returns {void}
     */
    function solveUnknownBand(img, trimap) {
      const { data, smoothed, w, h, background } = img;
      const offsets = buildSampleOffsets(trimap.bandWidth);
      const cand = createCandidateBuffer();

      for (let p = 0; p < w * h; p++) {
        const i = p * BYTES_PER_PIXEL;
        if (trimap.bgMask[p]) { data[i + OFFSET_ALPHA] = 0; continue; }
        if (trimap.fgMask[p]) continue;

        gatherCandidates(p, w, h, trimap, offsets, cand);
        if (cand.bgCount === 0) continue;

        const color = [data[i + OFFSET_RED], data[i + OFFSET_GREEN], data[i + OFFSET_BLUE]];
        const fit = { cost: Infinity, alpha: 1, fg: color, bg: background };
        findBestPair(smoothed, color, cand, fit);
        tryColorToAlpha(smoothed, color, cand, fit);
        writePixel(data, i, color, fit);
      }
    }

    // ------------------------------------------------------------ final clean-up

    /**
     * Removes small specks and lines that touch the image edge (leftover border artifacts)
     * by zeroing the alpha of edge-touching connected pieces that are tiny compared to
     * the largest piece.
     *
     * @param {Uint8ClampedArray} data RGBA pixels, modified in place.
     * @param {number} w @param {number} h
     * @returns {void}
     */
    function dropEdgeSpecks(data, w, h) {
      const n = w * h;
      const label = new Int32Array(n);
      const stack = new Int32Array(n);
      const edge = borderBandWidth(w, h) + EDGE_SPECK_EXTRA_MARGIN_PX;
      const sizes = [0], touchesEdge = [false]; // index 0 = unlabeled
      let pieces = 0;

      const isVisible = p => data[p * BYTES_PER_PIXEL + OFFSET_ALPHA] > SPECK_MIN_ALPHA;

      for (let start = 0; start < n; start++) {
        if (label[start] || !isVisible(start)) continue;
        pieces++;
        let top = 0, size = 0, touches = false;
        stack[top++] = start; label[start] = pieces;

        // Depth-first fill over 8-connected visible pixels.
        while (top > 0) {
          const p = stack[--top];
          size++;
          const x = p % w, y = Math.floor(p / w);
          if (x < edge || y < edge || x >= w - edge || y >= h - edge) touches = true;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= w) continue;
              const q = ny * w + nx;
              if (!label[q] && isVisible(q)) { label[q] = pieces; stack[top++] = q; }
            }
          }
        }
        sizes.push(size); touchesEdge.push(touches);
      }

      let largest = 0;
      for (let k = 1; k <= pieces; k++) if (sizes[k] > largest) largest = sizes[k];
      for (let p = 0; p < n; p++) {
        const k = label[p];
        if (k && touchesEdge[k] && sizes[k] < largest * SPECK_MAX_SHARE_OF_LARGEST) {
          data[p * BYTES_PER_PIXEL + OFFSET_ALPHA] = 0;
        }
      }
    }

    // ------------------------------------------------------------------ public API

    /**
     * Runs the whole matting pipeline on RGBA pixel data, modifying it in place.
     *
     * @param {Uint8ClampedArray} data RGBA pixels.
     * @param {number} w Width in px. @param {number} h Height in px.
     * @returns {boolean} `true` if a background was removed; `false` when the photo was
     *   left untouched (busy backdrop, already transparent, or nothing to cut).
     * @memberof Matting
     */
    function computeMatte(data, w, h) {
      const n = w * h;
      const background = estimateBackground(data, w, h);
      if (!background) return false;

      cleanBorder(data, w, h, background);
      const img = { data, smoothed: boxBlur(data, w, h), w, h, background };

      let bgMask = floodBackground(data, w, h, background);
      const share = countSet(bgMask) / n;
      if (share < MIN_BACKGROUND_SHARE || share > MAX_BACKGROUND_SHARE) return false;

      bgMask = sweepGradients(img, bgMask);
      bgMask = sweepShadows(img, bgMask);

      const trimap = buildTrimap(bgMask, w, h);
      solveUnknownBand(img, trimap);
      dropEdgeSpecks(data, w, h);
      return true;
    }

    /**
     * Removes the background from an image element and returns the result as a PNG.
     * If anything goes wrong the photo is returned as uploaded (scaled down if large).
     *
     * @param {HTMLImageElement} image A fully loaded image.
     * @returns {string} A `data:image/png` URL.
     * @memberof Matting
     */
    function removeBackground(image) {
      let w = image.naturalWidth, h = image.naturalHeight;
      const scale = Math.min(1, MAX_IMAGE_DIMENSION_PX / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0, w, h);
      try {
        const imageData = ctx.getImageData(0, 0, w, h);
        if (computeMatte(imageData.data, w, h)) ctx.putImageData(imageData, 0, 0);
      } catch (error) { /* keep the photo as uploaded */ }
      return canvas.toDataURL(OUTPUT_IMAGE_TYPE);
    }

    return { removeBackground, computeMatte };
  })();

  /* MATTING-END */

  /* RESIZE-MATH-START */

  /** Number of drag axes (x and y) that contribute to a proportional resize. */
  const RESIZE_AXIS_COUNT = 2;
  /** Smallest width a piece can be resized to (px). */
  const MIN_PIECE_SIZE_PX = 40;

  /**
   * @typedef {Object} Box
   * @property {number} x Left edge, relative to the table.
   * @property {number} y Top edge, relative to the table.
   * @property {number} w Width.
   * @property {number} h Height.
   */

  /**
   * Computes the new box of a piece while a corner handle is dragged. The piece keeps its
   * aspect ratio, the opposite corner stays fixed, and the result stays on the table and
   * above the minimum size.
   *
   * @param {Box} start The piece's box when the drag began.
   * @param {'nw'|'ne'|'sw'|'se'} corner The corner being dragged.
   * @param {number} dx Horizontal pointer movement since the drag began (px).
   * @param {number} dy Vertical pointer movement since the drag began (px).
   * @param {{width: number, height: number}} table Size of the table (px).
   * @returns {Box} The resized box.
   */
  function computeResizedBox(start, corner, dx, dy, table) {
    const growsRight = corner.indexOf('e') >= 0;
    const growsDown = corner.indexOf('s') >= 0;
    const directionX = growsRight ? 1 : -1;
    const directionY = growsDown ? 1 : -1;
    const aspect = start.w / start.h;

    // Pointer movement away from the fixed corner, averaged over both axes.
    const outwardX = dx * directionX;
    const outwardY = dy * directionY;
    let width = start.w + (outwardX + outwardY * aspect) / RESIZE_AXIS_COUNT;

    // Stay on the table: room available between the fixed corner and the table edge.
    const roomX = growsRight ? table.width - start.x : start.x + start.w;
    const roomY = growsDown ? table.height - start.y : start.y + start.h;
    width = Math.min(width, roomX, roomY * aspect);
    width = Math.max(width, MIN_PIECE_SIZE_PX, MIN_PIECE_SIZE_PX * aspect);
    const height = width / aspect;

    return {
      x: growsRight ? start.x : start.x + start.w - width,
      y: growsDown ? start.y : start.y + start.h - height,
      w: width,
      h: height
    };
  }

  /**
   * @typedef {Object} PieceLayout A piece's box plus its stacking order on the table.
   * @property {number} x Left edge. @property {number} y Top edge.
   * @property {number} w Width. @property {number} h Height.
   * @property {number} z CSS stacking order (higher is in front).
   */

  /**
   * Puts a saved box back on a table that may now be a different size (say, a narrower
   * window): it is shrunk proportionally if it no longer fits, then nudged back onto the table.
   *
   * @param {Box} box The saved box.
   * @param {{width: number, height: number}} table The table's current size (px).
   * @returns {Box}
   */
  function fitBoxInsideTable(box, table) {
    const aspect = box.w / box.h;
    let width = Math.min(box.w, table.width, table.height * aspect);
    width = Math.max(width, MIN_PIECE_SIZE_PX, MIN_PIECE_SIZE_PX * aspect);
    const height = width / aspect;
    return {
      x: Math.max(0, Math.min(box.x, table.width - width)),
      y: Math.max(0, Math.min(box.y, table.height - height)),
      w: width,
      h: height
    };
  }

  /* RESIZE-MATH-END */

  /* COLOR-MATH-START */

  // ------------------------------------------------------------------- hex notation
  /** Colors are written `#RRGGBB`. */
  const HEX_PREFIX = '#';
  const HEX_RADIX = 16;
  /** Each channel is written with this many hex digits. */
  const HEX_DIGITS_PER_CHANNEL = 2;
  /** `#ABC` shorthand has this many digits (one per channel, doubled when expanded). */
  const HEX_LENGTH_SHORT = 3;
  const HEX_LENGTH_FULL = 6;
  const HEX_CHARACTERS = /^[0-9a-f]+$/i;

  // ---------------------------------------------------------------- color channels
  const COLOR_CHANNEL_COUNT = 3;
  const COLOR_CHANNEL_MAX = 255;
  /** Rec. 601 weights giving how bright a color looks. */
  const PERCEIVED_WEIGHT_RED = 0.299;
  const PERCEIVED_WEIGHT_GREEN = 0.587;
  const PERCEIVED_WEIGHT_BLUE = 0.114;
  /** Colors brighter than this (0-255) get dark text on top; others get light text. */
  const LIGHT_COLOR_BRIGHTNESS = 150;

  // ------------------------------------------------------------------ hue geometry
  const HUE_DEGREES = 360;
  /** The hue circle is split into six 60° sectors (red→yellow→green→cyan→blue→magenta). */
  const HUE_SECTOR_DEGREES = 60;
  const HUE_SECTORS = 6;
  /** The "X" component rises and falls once every two sectors. */
  const HUE_TRIANGLE_PERIOD = 2;
  /** Sector offsets of green- and blue-dominant colors (red-dominant is 0). */
  const HUE_OFFSET_GREEN = 2;
  const HUE_OFFSET_BLUE = 4;
  const RADIANS_TO_DEGREES = 180 / Math.PI;
  const HALF = 0.5;

  // ---------------------------------------------------------------- wheel rendering
  /** Pixels within this distance outside the rim are blended for a smooth edge. */
  const WHEEL_EDGE_FEATHER_PX = 0.5;
  const BYTES_PER_PIXEL_RGBA = 4;
  /** Position of each channel inside an RGBA pixel (the first three also index `[r, g, b]`). */
  const PIXEL_RED = 0;
  const PIXEL_GREEN = 1;
  const PIXEL_BLUE = 2;
  const PIXEL_ALPHA = 3;

  /**
   * Cleans up a typed hex code: accepts `#abc`, `abc`, `#aabbcc` or `aabbcc` (any case,
   * surrounding spaces allowed) and returns `#AABBCC`.
   *
   * @param {string} text What the user typed.
   * @returns {?string} The normalized `#RRGGBB` code, or `null` if it isn't a valid color.
   */
  function normalizeHex(text) {
    let digits = String(text).trim();
    if (digits.charAt(0) === HEX_PREFIX) digits = digits.slice(HEX_PREFIX.length);
    if (!HEX_CHARACTERS.test(digits)) return null;
    if (digits.length === HEX_LENGTH_SHORT) {
      digits = digits.split('').map(digit => digit + digit).join('');
    }
    return digits.length === HEX_LENGTH_FULL ? HEX_PREFIX + digits.toUpperCase() : null;
  }

  /**
   * Converts a normalized hex code to channel values.
   * @param {string} hex A `#RRGGBB` code (see {@link normalizeHex}).
   * @returns {number[]} `[r, g, b]`, each 0-255.
   */
  function hexToRgb(hex) {
    const channels = [];
    for (let channel = 0; channel < COLOR_CHANNEL_COUNT; channel++) {
      const start = HEX_PREFIX.length + channel * HEX_DIGITS_PER_CHANNEL;
      channels.push(parseInt(hex.substr(start, HEX_DIGITS_PER_CHANNEL), HEX_RADIX));
    }
    return channels;
  }

  /**
   * Converts channel values to a hex code (values are rounded and limited to 0-255).
   * @param {number[]} rgb `[r, g, b]`.
   * @returns {string} `#RRGGBB`.
   */
  function rgbToHex(rgb) {
    return HEX_PREFIX + rgb.map(value => {
      const clamped = Math.min(COLOR_CHANNEL_MAX, Math.max(0, Math.round(value)));
      return clamped.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_CHANNEL, '0');
    }).join('').toUpperCase();
  }

  /**
   * Converts hue/saturation/value to channel values.
   * @param {number} hue Degrees; any number, wrapped into 0-360.
   * @param {number} saturation 0 (gray) to 1 (vivid).
   * @param {number} value 0 (black) to 1 (full brightness).
   * @returns {number[]} `[r, g, b]`, each 0-255 (not rounded).
   */
  function hsvToRgb(hue, saturation, value) {
    const wrapped = ((hue % HUE_DEGREES) + HUE_DEGREES) % HUE_DEGREES;
    const sector = wrapped / HUE_SECTOR_DEGREES;
    const chroma = value * saturation;
    const x = chroma * (1 - Math.abs((sector % HUE_TRIANGLE_PERIOD) - 1));
    const base = value - chroma;
    const bySector = [
      [chroma, x, 0], [x, chroma, 0], [0, chroma, x],
      [0, x, chroma], [x, 0, chroma], [chroma, 0, x]
    ];
    return bySector[Math.floor(sector) % HUE_SECTORS].map(part => (part + base) * COLOR_CHANNEL_MAX);
  }

  /**
   * Converts channel values to hue/saturation/value.
   * @param {number[]} rgb `[r, g, b]`, each 0-255.
   * @returns {{h: number, s: number, v: number}} Hue in degrees, saturation and value 0-1.
   */
  function rgbToHsv(rgb) {
    const [r, g, b] = rgb.map(channel => channel / COLOR_CHANNEL_MAX);
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let sector = 0;
    if (delta > 0) {
      if (max === r) sector = ((g - b) / delta) % HUE_SECTORS;
      else if (max === g) sector = (b - r) / delta + HUE_OFFSET_GREEN;
      else sector = (r - g) / delta + HUE_OFFSET_BLUE;
    }
    const hue = sector * HUE_SECTOR_DEGREES;
    return { h: hue < 0 ? hue + HUE_DEGREES : hue, s: max === 0 ? 0 : delta / max, v: max };
  }

  /**
   * Whether a color is light enough that dark text is the readable choice on top of it.
   * @param {string} hex A `#RRGGBB` code.
   * @returns {boolean}
   */
  function isLightColor(hex) {
    const [r, g, b] = hexToRgb(hex);
    return PERCEIVED_WEIGHT_RED * r + PERCEIVED_WEIGHT_GREEN * g +
           PERCEIVED_WEIGHT_BLUE * b > LIGHT_COLOR_BRIGHTNESS;
  }

  /**
   * Turns a point on the color wheel into a hue and saturation. Hue is the angle (0° points
   * right and increases clockwise); saturation grows from the center to the rim.
   *
   * @param {number} x Horizontal offset from the wheel's center.
   * @param {number} y Vertical offset from the wheel's center (down is positive).
   * @param {number} radius Radius of the wheel, in the same units.
   * @returns {{h: number, s: number}} Points outside the rim are treated as on the rim.
   */
  function wheelPointToHueSat(x, y, radius) {
    const degrees = Math.atan2(y, x) * RADIANS_TO_DEGREES;
    return {
      h: (degrees + HUE_DEGREES) % HUE_DEGREES,
      s: Math.min(1, Math.hypot(x, y) / radius)
    };
  }

  /**
   * The inverse of {@link wheelPointToHueSat}: where a hue/saturation sits on the wheel.
   * @param {number} hue Degrees. @param {number} saturation 0-1. @param {number} radius Wheel radius.
   * @returns {{x: number, y: number}} Offset from the wheel's center.
   */
  function hueSatToWheelPoint(hue, saturation, radius) {
    const angle = hue / RADIANS_TO_DEGREES;
    return { x: Math.cos(angle) * saturation * radius, y: Math.sin(angle) * saturation * radius };
  }

  /**
   * Renders the color wheel: hue around the circle, saturation from the center (white/gray)
   * out to the rim (vivid), everything at one brightness. Pixels outside the circle are
   * transparent.
   *
   * @param {number} size Width and height of the square image, in pixels.
   * @param {number} value Brightness 0-1 applied to the whole wheel.
   * @returns {Uint8ClampedArray} RGBA pixel data, `size * size * 4` long.
   */
  function renderWheelPixels(size, value) {
    const pixels = new Uint8ClampedArray(size * size * BYTES_PER_PIXEL_RGBA);
    const radius = size * HALF;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x + HALF - radius, dy = y + HALF - radius;
        const reach = radius - Math.hypot(dx, dy) + WHEEL_EDGE_FEATHER_PX;
        if (reach <= 0) continue;
        const { h, s } = wheelPointToHueSat(dx, dy, radius);
        const rgb = hsvToRgb(h, s, value);
        const i = (y * size + x) * BYTES_PER_PIXEL_RGBA;
        pixels[i + PIXEL_RED] = rgb[PIXEL_RED];
        pixels[i + PIXEL_GREEN] = rgb[PIXEL_GREEN];
        pixels[i + PIXEL_BLUE] = rgb[PIXEL_BLUE];
        pixels[i + PIXEL_ALPHA] = Math.min(1, reach) * COLOR_CHANNEL_MAX;
      }
    }
    return pixels;
  }

  /* COLOR-MATH-END */

  /* STORE-START */

  /**
   * Saving in the browser with IndexedDB, which (unlike localStorage) has room for a closet
   * full of pictures. Nothing here ever throws or hangs: if the browser blocks storage, the
   * calls simply report that nothing could be read or saved.
   *
   * @namespace Store
   */
  const Store = (function () {
    const DATABASE_NAME = 'manag-codes';
    const DATABASE_VERSION = 1;
    /** All records live in one object store, keyed by name. */
    const RECORD_STORE = 'records';
    const MODE_READ = 'readonly';
    const MODE_WRITE = 'readwrite';

    /**
     * Creates a store on top of a database factory.
     *
     * @param {?IDBFactory} factory Where databases come from, normally `window.indexedDB`.
     *   May be missing (storage unsupported or blocked).
     * @returns {{isAvailable: function(): Promise<boolean>,
     *   get: function(string): Promise<*>,
     *   set: function(string, *): Promise<boolean>}}
     * @memberof Store
     */
    function createStore(factory) {
      /** @type {?Promise<?IDBDatabase>} */
      let connection = null;

      /**
       * Opens the database once; resolves `null` instead of failing.
       * @returns {Promise<?IDBDatabase>}
       */
      function open() {
        if (!connection) {
          connection = new Promise(resolve => {
            try {
              const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
              request.onupgradeneeded = () => request.result.createObjectStore(RECORD_STORE);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => resolve(null);
              request.onblocked = () => resolve(null);
            } catch (error) {
              resolve(null);
            }
          });
        }
        return connection;
      }

      /**
       * Whether the browser allows saving at all.
       * @returns {Promise<boolean>}
       */
      async function isAvailable() {
        return (await open()) !== null;
      }

      /**
       * Reads a saved record.
       * @param {string} key @returns {Promise<*>} The record, or `undefined` if there is none
       *   (or it could not be read).
       */
      async function get(key) {
        const database = await open();
        if (!database) return undefined;
        return new Promise(resolve => {
          try {
            const request = database.transaction(RECORD_STORE, MODE_READ).objectStore(RECORD_STORE).get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(undefined);
          } catch (error) {
            resolve(undefined);
          }
        });
      }

      /**
       * Saves a record, replacing any earlier one with the same key.
       * @param {string} key @param {*} value Anything the browser can structured-clone.
       * @returns {Promise<boolean>} Whether the write completed (`false` if storage is
       *   blocked or full).
       */
      async function set(key, value) {
        const database = await open();
        if (!database) return false;
        return new Promise(resolve => {
          try {
            const transaction = database.transaction(RECORD_STORE, MODE_WRITE);
            transaction.oncomplete = () => resolve(true);
            transaction.onerror = () => resolve(false);
            transaction.onabort = () => resolve(false);
            transaction.objectStore(RECORD_STORE).put(value, key);
          } catch (error) {
            resolve(false);
          }
        });
      }

      return { isAvailable, get, set };
    }

    return { createStore };
  })();

  /* STORE-END */

  // ==================================================================================
  // Page controller
  // ==================================================================================

  // ------------------------------------------------------------------- configuration

  /** Most pieces allowed on the table before it must be cleared. */
  const MAX_PIECES = 10;
  /** Stacking order given to the first piece; brought-to-front pieces count up from here. */
  const BASE_Z_INDEX = 10;
  /** `PointerEvent.button` value of the primary (left) button. */
  const PRIMARY_BUTTON = 0;
  /** A new piece is scaled to fit inside a square of this size (px). */
  const INITIAL_PIECE_MAX_SIZE_PX = 200;
  /** Gap kept between the context menu and the window edge (px). */
  const CONTEXT_MENU_EDGE_GAP_PX = 8;
  /** Resize handles, one per corner of a selected piece. */
  const CORNERS = Object.freeze(['nw', 'ne', 'sw', 'se']);
  /** New pieces are laid out on a grid so they don't stack exactly on top of each other. */
  const LAYOUT = Object.freeze({ MARGIN_PX: 16, COLUMNS: 4, COLUMN_SPACING_PX: 180, ROW_SPACING_PX: 160 });
  /** Longest name a palette or outfit can be given (characters). */
  const MAX_NAME_LENGTH = 30;
  /** After the first click on "Delete palette" the second click must come within this time. */
  const DELETE_CONFIRM_TIMEOUT_MS = 3000;
  /** Most colors one palette can hold. */
  const MAX_COLORS_PER_PALETTE = 5;
  /** Color the add-color dialog starts with the first time it opens. */
  const DEFAULT_COLOR = '#AE6035';
  /** Pixels with less alpha than this count as "nothing there" for the color drop tool. */
  const MIN_PICKABLE_ALPHA = 16;
  /** `error.name` when the user dismisses the browser's eyedropper. */
  const ABORT_ERROR_NAME = 'AbortError';
  /** Size of the marker on the color wheel, in CSS pixels. */
  const WHEEL_MARKER_RADIUS_PX = 8;
  const WHEEL_MARKER_RING_PX = 2.5;
  /** The dark outline is drawn this many times wider than the white ring so it frames it. */
  const WHEEL_MARKER_OUTLINE_FACTOR = 2;
  const WHEEL_MARKER_RING_COLOR = '#FFFFFF';
  const WHEEL_MARKER_OUTLINE_COLOR = 'rgba(0, 0, 0, 0.55)';
  /** One full turn in radians. */
  const FULL_CIRCLE_RAD = 2 * Math.PI;
  /** What changed the dialog's color: decides which control is left untouched. */
  const SOURCE = Object.freeze({ OPEN: 'open', WHEEL: 'wheel', SLIDER: 'slider', HEX: 'hex' });
  /** After the last change, wait this long before writing to storage (a drag saves once). */
  const SAVE_DELAY_MS = 300;
  /** Bump when the saved data's shape changes; records with another version are ignored. */
  const SCHEMA_VERSION = 1;
  /** The separate records everything is saved in. */
  const RECORD = Object.freeze({
    PALETTES: 'palettes', OUTFITS: 'outfits', TABLE: 'table', SETTINGS: 'settings'
  });
  /** The site's tabs (the value of each tab button's `data-tab`). */
  const TAB = Object.freeze({ HOME: 'home', OUTFITS: 'outfits', PALETTES: 'palettes' });
  /** Saved pictures must be data URLs of images, never links to somewhere else. */
  const IMAGE_DATA_URL_PREFIX = 'data:image/';
  /** Format used for saved outfit images. */
  const OUTFIT_IMAGE_TYPE = 'image/png';
  /** Base used when reading a piece's stacking order back from its style. */
  const DECIMAL_RADIX = 10;

  /** `KeyboardEvent.key` values the page reacts to. */
  const KEY = Object.freeze({ ESCAPE: 'Escape', ENTER: 'Enter', SPACE: ' ', TAB: 'Tab' });

  /** CSS class names shared with `styles.css`. */
  const CLASS = Object.freeze({
    PIECE: 'item', HANDLE: 'handle', SELECTED: 'selected', DRAGGING: 'dragging',
    DRAG_OVER: 'drag-over', OUTFIT_CARD: 'outfit-card', OUTFIT_META: 'meta',
    PICKING: 'picking', PALETTE: 'palette', PALETTE_HEADER: 'palette-header',
    PALETTE_TITLE: 'palette-title', PALETTE_TOOLS: 'palette-tools', PALETTE_COUNT: 'palette-count',
    PALETTE_COLUMNS: 'palette-columns', PALETTE_COLOR: 'palette-color',
    OUTFIT_PREVIEW: 'outfit-preview', OUTFIT_INFO: 'outfit-info', OUTFIT_NAME: 'outfit-name',
    OUTFIT_FOOTER: 'outfit-footer', PALETTE_NAME: 'palette-name', PALETTE_SLOT: 'palette-slot',
    PALETTE_HEX: 'palette-hex',
    LIGHT: 'light', DARK: 'dark',
    PALETTE_COLOR_DELETE: 'palette-color-delete', BUTTON: 'btn', GHOST: 'ghost',
    PRIMARY: 'primary', SMALL: 'small', DANGER: 'danger'
  });

  /** User-facing messages. */
  const MESSAGE = Object.freeze({
    FULL: "Your closet's full — hit Clear closet to add more.",
    NOTHING_TO_SAVE: 'Add something to the table before saving.',
    SAVED: 'Saved to My Outfits.',
    onlyRoomFor: remaining => 'Only room for ' + remaining + ' more right now — added what fits.',
    pieceCount: count => count + ' of ' + MAX_PIECES + ' pieces',
    outfitSize: count => count + (count === 1 ? ' piece' : ' pieces'),
    outfitTitle: number => 'Outfit ' + number,
    viewOutfit: title => 'View ' + title,
    DELETE_PIECE: 'Delete piece',
    DELETE_OUTFIT: 'Delete outfit',
    DELETE_PALETTE: 'Delete palette',
    DELETE_COLOR: 'Delete color',
    ADD_COLOR: 'Add color',
    CONFIRM_DELETE: 'Click again to delete',
    REMOVE_GLYPH: '\u00D7',                      // the × drawn on a color's delete button
    deleteColorLabel: hex => 'Delete ' + hex,
    paletteTitle: number => 'Color palette ' + number,
    PALETTE_NAME_LABEL: 'Palette name',
    OUTFIT_NAME_LABEL: 'Outfit name',
    paletteCount: count => count + ' of ' + MAX_COLORS_PER_PALETTE + ' colors',
    addColorTo: name => 'Add a color to ' + name,
    INVALID_HEX: 'Enter a valid hex code, like #AE6035.',
    NOTHING_TO_PICK: 'Add a photo first, then use Color drop to pick a color from it.',
    PICK_HINT: 'Click a piece to pick its color. Press Esc to cancel.',
    TRANSPARENT_SPOT: 'That spot is transparent. Click a colored part of a piece.',
    picked: hex => 'Picked ' + hex + '.',
    copied: hex => 'Copied ' + hex + '.',
    COPY_MANUALLY: "Couldn't copy automatically. Press Ctrl+C (Cmd+C on a Mac).",
    STORAGE_UNAVAILABLE: "This browser isn't allowing saving, so your work will be lost when you refresh.",
    SAVE_FAILED: "Couldn't save your latest changes in this browser. They may be lost if you refresh."
  });

  // --------------------------------------------------------------------- page elements

  /** @param {string} id @returns {HTMLElement} */
  const byId = id => document.getElementById(id);

  const el = {
    workspace: byId('workspace'),
    emptyState: byId('empty-state'),
    fileInput: byId('file-input'),
    addButton: byId('add-btn'),
    saveButton: byId('save-btn'),
    clearButton: byId('clear-btn'),
    counter: byId('counter'),
    status: byId('status'),
    outfitsGrid: byId('outfits-grid'),
    outfitsEmpty: byId('outfits-empty'),
    outfitsHint: byId('outfits-hint'),
    contextMenu: byId('ctx-menu'),
    contextDelete: byId('ctx-delete'),
    lightbox: byId('lightbox'),
    lightboxImage: byId('lightbox-image'),
    lightboxTitle: byId('lightbox-title'),
    lightboxDetails: byId('lightbox-details'),
    lightboxClose: byId('lightbox-close'),
    colorDropButton: byId('color-drop-btn'),
    picked: byId('picked'),
    pickedSwatch: byId('picked-swatch'),
    pickedHex: byId('picked-hex'),
    pickedCopy: byId('picked-copy'),
    newPaletteButton: byId('new-palette-btn'),
    palettesList: byId('palettes-list'),
    palettesEmpty: byId('palettes-empty'),
    colorDialog: byId('color-dialog'),
    colorDialogPanel: byId('color-dialog-panel'),
    colorDialogTitle: byId('color-dialog-title'),
    colorWheel: byId('color-wheel'),
    colorValue: byId('color-value'),
    colorHex: byId('color-hex'),
    colorPreview: byId('color-preview'),
    colorError: byId('color-error'),
    colorCancel: byId('color-cancel'),
    colorConfirm: byId('color-confirm')
  };

  // --------------------------------------------------------------------------- state

  /**
   * Everything that changes while the page is used.
   * @type {{pieceCount: number, topZ: number, selected: ?HTMLElement,
   *   contextTarget: ?HTMLElement, outfits: Outfit[], viewerOpener: ?HTMLElement,
   *   palettes: Palette[],
   *   colorDialog: ?{palette: Palette, opener: HTMLElement},
   *   color: {h: number, s: number, v: number}, pickingColor: boolean, tab: string,
   *   restored: boolean, storageAvailable: boolean, storageWarned: boolean}}
   */
  const state = {
    pieceCount: 0,
    topZ: BASE_Z_INDEX,
    selected: null,
    contextTarget: null,
    outfits: [],
    viewerOpener: null,
    palettes: [],
    colorDialog: null,
    color: rgbToHsv(hexToRgb(DEFAULT_COLOR)),
    pickingColor: false,
    tab: TAB.HOME,
    restored: false,          // true once saved data has been loaded (saving waits for this)
    storageAvailable: true,
    storageWarned: false
  };

  // ------------------------------------------------------------------- status/counter

  /**
   * Shows a short message under the toolbar (empty string clears it).
   * @param {string} [message] @returns {void}
   */
  function setStatus(message) {
    el.status.textContent = message || '';
  }

  /**
   * Refreshes the piece counter and enables/disables the buttons that depend on it.
   * @returns {void}
   */
  function updateCounter() {
    el.counter.textContent = MESSAGE.pieceCount(state.pieceCount);
    const isFull = state.pieceCount >= MAX_PIECES;
    el.addButton.disabled = isFull;
    el.fileInput.disabled = isFull;
    el.saveButton.disabled = state.pieceCount === 0;
  }

  // ------------------------------------------------------------------- context menu

  /**
   * Opens the right-click "Delete" menu at the pointer, kept inside the window.
   * @param {MouseEvent} event The `contextmenu` event.
   * @param {HTMLElement} target The piece or outfit card the menu will delete.
   * @returns {void}
   */
  function openContextMenu(event, target) {
    event.preventDefault();
    state.contextTarget = target;
    el.contextDelete.textContent = deleteLabelFor(target);
    el.contextMenu.hidden = false;
    const maxLeft = window.innerWidth - el.contextMenu.offsetWidth - CONTEXT_MENU_EDGE_GAP_PX;
    const maxTop = window.innerHeight - el.contextMenu.offsetHeight - CONTEXT_MENU_EDGE_GAP_PX;
    el.contextMenu.style.left = Math.min(event.clientX, maxLeft) + 'px';
    el.contextMenu.style.top = Math.min(event.clientY, maxTop) + 'px';
  }

  /**
   * Wording of the menu's delete button for the thing that was right-clicked.
   * @param {HTMLElement} target A piece, outfit card, palette or palette color.
   * @returns {string}
   */
  function deleteLabelFor(target) {
    if (target.classList.contains(CLASS.PALETTE_COLOR)) return MESSAGE.DELETE_COLOR;
    if (target.classList.contains(CLASS.PALETTE)) return MESSAGE.DELETE_PALETTE;
    if (target.classList.contains(CLASS.OUTFIT_CARD)) return MESSAGE.DELETE_OUTFIT;
    return MESSAGE.DELETE_PIECE;
  }

  /**
   * Hides the context menu and forgets its target.
   * @returns {void}
   */
  function closeContextMenu() {
    el.contextMenu.hidden = true;
    state.contextTarget = null;
  }

  /**
   * Deletes a piece from the table.
   * @param {HTMLElement} piece @returns {void}
   */
  function deletePiece(piece) {
    if (state.selected === piece) state.selected = null;
    piece.remove();
    state.pieceCount = Math.max(0, state.pieceCount - 1);
    if (state.pieceCount === 0) el.emptyState.hidden = false;
    updateCounter();
    scheduleSave(RECORD.TABLE);
  }

  /**
   * Wires the menu: close on outside click/scroll/resize/Escape, delete on click.
   * @returns {void}
   */
  function wireContextMenu() {
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('resize', closeContextMenu);
    document.addEventListener('keydown', event => { if (event.key === KEY.ESCAPE) closeContextMenu(); });

    el.contextDelete.addEventListener('click', () => {
      const target = state.contextTarget;
      if (!target) return;
      if (target.classList.contains(CLASS.PIECE)) deletePiece(target);
      else if (target.classList.contains(CLASS.OUTFIT_CARD)) deleteOutfit(target);
      else if (target.classList.contains(CLASS.PALETTE_COLOR)) deletePaletteColor(target);
      else if (target.classList.contains(CLASS.PALETTE)) deletePalette(target);
    });
  }

  // ------------------------------------------------------------- dialog focus trap

  /**
   * Keeps Tab / Shift+Tab cycling inside a dialog instead of escaping to the page behind.
   * @param {KeyboardEvent} event The Tab keydown event.
   * @param {HTMLElement[]} controls The dialog's focusable controls, in tab order.
   * @returns {void}
   */
  function trapTabFocus(event, controls) {
    event.preventDefault();
    const step = event.shiftKey ? -1 : 1;
    const current = controls.indexOf(document.activeElement);
    const next = current === -1
      ? (step > 0 ? 0 : controls.length - 1)
      : (current + step + controls.length) % controls.length;
    controls[next].focus();
  }

  // ------------------------------------------------------------------ outfit viewer

  /**
   * Whether the outfit viewer is currently showing.
   * @returns {boolean}
   */
  function isViewerOpen() {
    return !el.lightbox.hidden;
  }

  /**
   * Shows a saved outfit large, on top of the page.
   * @param {string} imageUrl The saved outfit picture.
   * @param {string} title Heading, e.g. "Outfit 2".
   * @param {string} details Small line under the heading, e.g. "3 pieces".
   * @param {HTMLElement} opener The card that opened the viewer; focus returns to it on close.
   * @returns {void}
   */
  function openOutfitViewer(imageUrl, title, details, opener) {
    closeContextMenu();
    state.viewerOpener = opener;
    el.lightboxImage.src = imageUrl;
    el.lightboxImage.alt = title;
    el.lightboxTitle.textContent = title;
    el.lightboxDetails.textContent = details;
    el.lightbox.hidden = false;
    el.lightboxClose.focus();
  }

  /**
   * Hides the outfit viewer and hands focus back to the card that opened it.
   * @returns {void}
   */
  function closeOutfitViewer() {
    if (!isViewerOpen()) return;
    el.lightbox.hidden = true;
    el.lightboxImage.removeAttribute('src');
    if (state.viewerOpener) state.viewerOpener.focus();
    state.viewerOpener = null;
  }

  /**
   * Wires the viewer: close button, click on the dark backdrop, Escape, and a simple
   * focus trap (the close button is the only control, so Tab stays on it).
   * @returns {void}
   */
  function wireViewer() {
    el.lightboxClose.addEventListener('click', closeOutfitViewer);
    el.lightbox.addEventListener('click', event => {
      if (event.target === el.lightbox) closeOutfitViewer(); // backdrop only, not the panel
    });
    el.lightboxImage.addEventListener('dragstart', event => event.preventDefault());
    el.lightboxImage.addEventListener('contextmenu', event => event.preventDefault());

    document.addEventListener('keydown', event => {
      if (!isViewerOpen()) return;
      if (event.key === KEY.ESCAPE) closeOutfitViewer();
      else if (event.key === KEY.TAB) trapTabFocus(event, [el.lightboxClose]);
    });
  }

  // ------------------------------------------------- selecting, dragging, resizing

  /**
   * Marks a piece as selected (showing its resize handles) and deselects the previous one.
   * @param {?HTMLElement} piece The piece to select, or `null` to clear the selection.
   * @returns {void}
   */
  function selectPiece(piece) {
    if (state.selected && state.selected !== piece) state.selected.classList.remove(CLASS.SELECTED);
    state.selected = piece;
    if (piece) piece.classList.add(CLASS.SELECTED);
  }

  /**
   * Lets a piece be dragged around the table with the pointer (mouse or touch). Dragging
   * selects it and brings it to the front; it cannot leave the table.
   * @param {HTMLElement} piece @returns {void}
   */
  function makeDraggable(piece) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;

    piece.addEventListener('pointerdown', event => {
      if (event.button !== PRIMARY_BUTTON) return;
      if (state.pickingColor) {            // color drop is waiting for a click: sample, don't drag
        event.preventDefault();
        pickColorFromPiece(piece, event);
        return;
      }
      if (event.target.classList && event.target.classList.contains(CLASS.HANDLE)) return;
      selectPiece(piece);
      dragging = true;
      piece.setPointerCapture(event.pointerId);
      startX = event.clientX; startY = event.clientY;
      startLeft = piece.offsetLeft; startTop = piece.offsetTop;
      piece.style.zIndex = ++state.topZ;
      piece.classList.add(CLASS.DRAGGING);
    });

    piece.addEventListener('pointermove', event => {
      if (!dragging) return;
      const maxLeft = el.workspace.clientWidth - piece.offsetWidth;
      const maxTop = el.workspace.clientHeight - piece.offsetHeight;
      const left = Math.max(0, Math.min(startLeft + (event.clientX - startX), maxLeft));
      const top = Math.max(0, Math.min(startTop + (event.clientY - startY), maxTop));
      piece.style.left = left + 'px';
      piece.style.top = top + 'px';
    });

    const stopDragging = () => {
      if (dragging) scheduleSave(RECORD.TABLE);     // moved, or at least brought to the front
      dragging = false;
      piece.classList.remove(CLASS.DRAGGING);
    };
    piece.addEventListener('pointerup', stopDragging);
    piece.addEventListener('pointercancel', stopDragging);
  }

  /**
   * Makes a corner handle resize its piece proportionally (see {@link computeResizedBox}).
   * @param {HTMLElement} piece The piece to resize.
   * @param {HTMLElement} handle The corner handle element.
   * @param {'nw'|'ne'|'sw'|'se'} corner Which corner the handle sits on.
   * @returns {void}
   */
  function makeResizable(piece, handle, corner) {
    /** @type {?{pointerX: number, pointerY: number, box: Box}} */
    let drag = null;

    handle.addEventListener('pointerdown', event => {
      if (event.button !== PRIMARY_BUTTON) return;
      event.stopPropagation();
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      selectPiece(piece);
      piece.style.zIndex = ++state.topZ;
      drag = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        box: { x: piece.offsetLeft, y: piece.offsetTop, w: piece.offsetWidth, h: piece.offsetHeight }
      };
    });

    handle.addEventListener('pointermove', event => {
      if (!drag) return;
      const table = { width: el.workspace.clientWidth, height: el.workspace.clientHeight };
      const box = computeResizedBox(
        drag.box, corner, event.clientX - drag.pointerX, event.clientY - drag.pointerY, table);
      piece.style.left = box.x + 'px';
      piece.style.top = box.y + 'px';
      piece.style.width = box.w + 'px';
      piece.style.height = box.h + 'px';
    });

    const stopResizing = () => {
      if (drag) scheduleSave(RECORD.TABLE);
      drag = null;
    };
    handle.addEventListener('pointerup', stopResizing);
    handle.addEventListener('pointercancel', stopResizing);
  }

  // ------------------------------------------------------------------------ the table

  /**
   * Builds a piece element: the picture plus one resize handle per corner.
   * @param {string} src Image URL (a data URL from the matting step).
   * @param {PieceLayout} [layout] A saved size to restore; without it the piece starts at a
   *   comfortable size once its picture has loaded.
   * @returns {HTMLElement}
   */
  function createPiece(src, layout) {
    const piece = document.createElement('div');
    piece.className = CLASS.PIECE;

    const image = document.createElement('img');
    image.alt = 'Uploaded photo';
    image.draggable = false;
    piece.appendChild(image);

    CORNERS.forEach(corner => {
      const handle = document.createElement('div');
      handle.className = CLASS.HANDLE + ' ' + CLASS.HANDLE + '-' + corner;
      piece.appendChild(handle);
      makeResizable(piece, handle, corner);
    });

    if (layout) {
      piece.style.width = layout.w + 'px';
      piece.style.height = layout.h + 'px';
    } else {
      // Start at a comfortable size, then the user can resize.
      image.addEventListener('load', () => {
        const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
        const fit = Math.min(1, INITIAL_PIECE_MAX_SIZE_PX / longestSide);
        piece.style.width = Math.max(MIN_PIECE_SIZE_PX, Math.round(image.naturalWidth * fit)) + 'px';
        piece.style.height = Math.max(MIN_PIECE_SIZE_PX, Math.round(image.naturalHeight * fit)) + 'px';
      });
    }
    image.src = src;

    piece.addEventListener('dragstart', event => event.preventDefault());
    piece.addEventListener('contextmenu', event => openContextMenu(event, piece));
    return piece;
  }

  /**
   * Places a new piece on the table: on the next free grid slot, or where it was saved.
   * @param {string} src Image URL.
   * @param {PieceLayout} [layout] A saved position, size and stacking order to restore.
   * @returns {void}
   */
  function addToWorkspace(src, layout) {
    if (state.pieceCount >= MAX_PIECES) return;
    el.emptyState.hidden = true;

    const index = state.pieceCount;
    const piece = createPiece(src, layout);
    if (layout) {
      piece.style.left = layout.x + 'px';
      piece.style.top = layout.y + 'px';
      piece.style.zIndex = String(layout.z);
      state.topZ = Math.max(state.topZ, layout.z);
    } else {
      piece.style.left = (LAYOUT.MARGIN_PX + (index % LAYOUT.COLUMNS) * LAYOUT.COLUMN_SPACING_PX) + 'px';
      const row = Math.floor(index / LAYOUT.COLUMNS);
      piece.style.top = (LAYOUT.MARGIN_PX + row * LAYOUT.ROW_SPACING_PX) + 'px';
      piece.style.zIndex = String(BASE_Z_INDEX + index);
    }
    el.workspace.appendChild(piece);
    makeDraggable(piece);

    state.pieceCount++;
    updateCounter();
    scheduleSave(RECORD.TABLE);
  }

  // ---------------------------------------------------------------------- uploading

  /**
   * Loads one image file, removes its background (falling back to the original photo if
   * that fails) and places it on the table.
   * @param {File} file @returns {void}
   */
  function processFile(file) {
    if (state.pieceCount >= MAX_PIECES || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      let result;
      try { result = Matting.removeBackground(image); }
      catch (error) { result = url; }
      addToWorkspace(result);
      URL.revokeObjectURL(url);
    };
    image.onerror = () => addToWorkspace(url);
    image.src = url;
  }

  /**
   * Handles files chosen or dropped by the user, respecting the piece limit.
   * @param {FileList|File[]} fileList @returns {void}
   */
  function handleFiles(fileList) {
    const files = Array.from(fileList);
    const remaining = MAX_PIECES - state.pieceCount;
    if (files.length > remaining) {
      setStatus(remaining === 0 ? MESSAGE.FULL : MESSAGE.onlyRoomFor(remaining));
    } else {
      setStatus('');
    }
    files.slice(0, remaining).forEach(processFile);
  }

  /**
   * Wires the file picker button and drag-and-drop onto the table.
   * @returns {void}
   */
  function wireUploads() {
    el.addButton.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', event => {
      handleFiles(event.target.files);
      el.fileInput.value = '';
    });

    el.workspace.addEventListener('dragover', event => {
      event.preventDefault();
      el.workspace.classList.add(CLASS.DRAG_OVER);
    });
    el.workspace.addEventListener('dragleave', () => el.workspace.classList.remove(CLASS.DRAG_OVER));
    el.workspace.addEventListener('drop', event => {
      event.preventDefault();
      el.workspace.classList.remove(CLASS.DRAG_OVER);
      if (event.dataTransfer && event.dataTransfer.files.length) handleFiles(event.dataTransfer.files);
    });

    // Clicking bare table space deselects the current piece.
    el.workspace.addEventListener('pointerdown', event => {
      if (event.target === el.workspace || el.emptyState.contains(event.target)) selectPiece(null);
    });
  }

  // ------------------------------------------- shared: editable names, two-step delete

  /**
   * @typedef {Object} Nameable Anything with an editable name (a palette or an outfit).
   * @property {string} name The current name.
   * @property {HTMLInputElement} nameInput The text field that shows and edits it.
   */

  /**
   * @typedef {Object} Deletable Anything with a "Delete" button that asks to be clicked twice.
   * @property {HTMLButtonElement} deleteButton The button.
   * @property {?number} confirmTimer Timer id while the button waits for its second click,
   *   otherwise `null`.
   */

  /**
   * Creates an element with a class name and optional text.
   * @param {string} tag @param {string} className @param {string} [text]
   * @returns {HTMLElement}
   */
  function createElementWith(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  /**
   * The default name for something new: the smallest numbered name ("Outfit 1", "Outfit 2",
   * ...) that nothing is using right now. Deleting or renaming frees a number again, so new
   * items never skip ahead. Comparison ignores case and surrounding spaces.
   *
   * @param {string[]} usedNames Names currently in use.
   * @param {(number: number) => string} makeName Builds the name for a number.
   * @returns {string}
   */
  function nextFreeName(usedNames, makeName) {
    const taken = new Set(usedNames.map(name => name.trim().toLowerCase()));
    let number = 1;
    while (taken.has(makeName(number).toLowerCase())) number++;
    return makeName(number);
  }

  /**
   * Creates a name field: a text input that looks like a heading until hovered or focused.
   * @param {string} className CSS class for the field.
   * @param {string} name Starting text. @param {string} ariaLabel What screen readers call it.
   * @returns {HTMLInputElement}
   */
  function createNameField(className, name, ariaLabel) {
    const input = createElementWith('input', className);
    input.type = 'text';
    input.value = name;
    input.maxLength = MAX_NAME_LENGTH;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', ariaLabel);
    return input;
  }

  /**
   * Makes a name field editable: typing renames the item, Enter or clicking away finishes
   * (an empty name reverts to the previous one), Escape cancels the edit.
   *
   * @param {Nameable} item
   * @param {() => void} [onRename] Called whenever `item.name` changes (to refresh labels).
   * @returns {void}
   */
  function wireNameField(item, onRename) {
    const input = item.nameInput;
    let nameWhenFocused = item.name;
    const renamed = () => { if (onRename) onRename(); };

    input.addEventListener('focus', () => { nameWhenFocused = item.name; });
    input.addEventListener('input', () => {
      const typed = input.value.trim();
      if (!typed) return;                   // ignore an empty field until something is typed
      item.name = typed;
      renamed();
    });
    input.addEventListener('blur', () => { input.value = item.name; });
    input.addEventListener('keydown', event => {
      if (event.key === KEY.ENTER) {
        input.blur();
      } else if (event.key === KEY.ESCAPE) {
        item.name = nameWhenFocused;
        renamed();
        input.blur();
      }
    });
  }

  /**
   * Puts a "Delete" button back to normal (cancels a pending confirmation).
   * @param {Deletable} item @param {string} label The button's normal text.
   * @returns {void}
   */
  function resetDeleteConfirm(item, label) {
    clearTimeout(item.confirmTimer);
    item.confirmTimer = null;
    item.deleteButton.textContent = label;
    item.deleteButton.classList.remove(CLASS.DANGER);
  }

  /**
   * Handles a click on a "Delete" button. When `needsConfirm` is set, the first click turns
   * the button red ("Click again to delete") and the second click within a few seconds
   * deletes, so a stray click can't destroy something. Otherwise it deletes at once.
   *
   * @param {Deletable} item @param {string} label The button's normal text.
   * @param {boolean} needsConfirm Whether a second click is required.
   * @param {() => void} remove Does the actual deletion.
   * @returns {void}
   */
  function requestDelete(item, label, needsConfirm, remove) {
    if (!needsConfirm || item.confirmTimer !== null) { remove(); return; }
    item.deleteButton.textContent = MESSAGE.CONFIRM_DELETE;
    item.deleteButton.classList.add(CLASS.DANGER);
    item.confirmTimer = setTimeout(() => resetDeleteConfirm(item, label), DELETE_CONFIRM_TIMEOUT_MS);
  }

  // ------------------------------------------------------------------ save and clear

  /**
   * Flattens the table into one image, drawing pieces in their on-screen stacking order.
   * @returns {string} A `data:image/png` URL.
   */
  function renderTableToImage() {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, el.workspace.clientWidth);
    canvas.height = Math.max(1, el.workspace.clientHeight);
    const ctx = canvas.getContext('2d');

    const zIndexOf = piece => parseInt(piece.style.zIndex, DECIMAL_RADIX) || 0;
    Array.from(el.workspace.querySelectorAll('.' + CLASS.PIECE))
      .sort((a, b) => zIndexOf(a) - zIndexOf(b))
      .forEach(piece => {
        ctx.drawImage(piece.querySelector('img'),
          piece.offsetLeft, piece.offsetTop, piece.offsetWidth, piece.offsetHeight);
      });
    return canvas.toDataURL(OUTFIT_IMAGE_TYPE);
  }

  /**
   * @typedef {Object} Outfit A saved look in "My Outfits".
   * @property {string} name Label shown on the card, e.g. "Outfit 1" (the user can change it).
   * @property {HTMLInputElement} nameInput The editable label.
   * @property {string} imageUrl The flattened table picture.
   * @property {number} pieceCount How many pieces the look contains.
   * @property {HTMLElement} card The outfit's element.
   * @property {HTMLElement} preview The clickable picture that opens the viewer.
   * @property {HTMLImageElement} image The picture.
   * @property {HTMLButtonElement} deleteButton The "Delete outfit" button.
   * @property {?number} confirmTimer Timer id while the delete button waits for its second click.
   */

  /**
   * Builds a saved-outfit card: the picture (click to view it large), an editable label,
   * the piece count and a "Delete outfit" button. Right-clicking the card (but not the
   * label field) offers to delete it.
   *
   * @param {string} imageUrl The flattened table image.
   * @param {number} pieceCount How many pieces the look contains.
   * @param {string} [savedName] The name it was saved with; new outfits get the next free "Outfit N".
   * @returns {Outfit}
   */
  function createOutfit(imageUrl, pieceCount, savedName) {
    const name = savedName || nextFreeName(state.outfits.map(outfit => outfit.name), MESSAGE.outfitTitle);
    const details = MESSAGE.outfitSize(pieceCount);
    const card = createElementWith('div', CLASS.OUTFIT_CARD);

    // The picture is a button that opens the outfit in the viewer.
    const preview = createElementWith('div', CLASS.OUTFIT_PREVIEW);
    preview.tabIndex = 0;
    preview.setAttribute('role', 'button');
    const image = document.createElement('img');
    image.src = imageUrl;
    image.draggable = false;
    image.addEventListener('dragstart', event => event.preventDefault());
    preview.appendChild(image);

    const nameInput = createNameField(CLASS.OUTFIT_NAME, name, MESSAGE.OUTFIT_NAME_LABEL);
    const deleteButton = createElementWith(
      'button', [CLASS.BUTTON, CLASS.GHOST, CLASS.SMALL].join(' '), MESSAGE.DELETE_OUTFIT);
    deleteButton.type = 'button';
    const footer = createElementWith('div', CLASS.OUTFIT_FOOTER);
    footer.appendChild(createElementWith('div', CLASS.OUTFIT_META, details));
    footer.appendChild(deleteButton);
    const info = createElementWith('div', CLASS.OUTFIT_INFO);
    info.appendChild(nameInput);
    info.appendChild(footer);
    card.appendChild(preview);
    card.appendChild(info);

    /** @type {Outfit} */
    const outfit = {
      name, nameInput, imageUrl, pieceCount, card, preview, image, deleteButton, confirmTimer: null
    };

    // The picture's alt text and the button's label follow the outfit's current name.
    const refreshLabels = () => {
      image.alt = outfit.name;
      preview.setAttribute('aria-label', MESSAGE.viewOutfit(outfit.name));
    };
    refreshLabels();
    wireNameField(outfit, () => {
      refreshLabels();
      scheduleSave(RECORD.OUTFITS);
    });

    const openViewer = () => openOutfitViewer(imageUrl, outfit.name, details, preview);
    preview.addEventListener('click', openViewer);
    preview.addEventListener('keydown', event => {
      if (event.key !== KEY.ENTER && event.key !== KEY.SPACE) return;
      event.preventDefault();
      openViewer();
    });
    deleteButton.addEventListener('click', () =>
      requestDelete(outfit, MESSAGE.DELETE_OUTFIT, true, () => removeOutfit(outfit)));
    card.addEventListener('contextmenu', event => {
      if (event.target === nameInput) return;   // leave the browser's text menu for renaming
      openContextMenu(event, card);
    });
    return outfit;
  }

  /**
   * Deletes a saved outfit card and restores the empty message if none are left.
   * @param {HTMLElement} card The outfit's card. @returns {void}
   */
  function deleteOutfit(card) {
    const doomed = state.outfits.find(outfit => outfit.card === card);
    if (doomed) clearTimeout(doomed.confirmTimer);
    state.outfits = state.outfits.filter(outfit => outfit.card !== card);
    card.remove();
    if (state.outfits.length === 0) {
      el.outfitsGrid.hidden = true;
      el.outfitsHint.hidden = true;
      el.outfitsEmpty.hidden = false;
    }
    scheduleSave(RECORD.OUTFITS);
  }

  /**
   * Deletes an outfit from its button and moves keyboard focus to a neighboring outfit.
   * @param {Outfit} outfit @returns {void}
   */
  function removeOutfit(outfit) {
    const index = state.outfits.indexOf(outfit);
    deleteOutfit(outfit.card);
    const neighbor = state.outfits[Math.min(index, state.outfits.length - 1)];
    if (neighbor) neighbor.preview.focus();
  }

  /**
   * Saves whatever is on the table as a new outfit (newest first).
   * @returns {void}
   */
  function saveOutfit() {
    if (state.pieceCount === 0) { setStatus(MESSAGE.NOTHING_TO_SAVE); return; }
    const outfit = createOutfit(renderTableToImage(), state.pieceCount);
    state.outfits.unshift(outfit);
    el.outfitsGrid.prepend(outfit.card);
    el.outfitsEmpty.hidden = true;
    el.outfitsHint.hidden = false;
    el.outfitsGrid.hidden = false;
    setStatus(MESSAGE.SAVED);
    scheduleSave(RECORD.OUTFITS);
  }

  /**
   * Removes every piece from the table.
   * @returns {void}
   */
  function clearTable() {
    el.workspace.querySelectorAll('.' + CLASS.PIECE).forEach(piece => piece.remove());
    state.selected = null;
    state.pieceCount = 0;
    state.topZ = BASE_Z_INDEX;
    el.emptyState.hidden = false;
    setStatus('');
    updateCounter();
    scheduleSave(RECORD.TABLE);
  }

  // -------------------------------------------------------------------- palettes

  /**
   * @typedef {Object} Palette
   * @property {string} name Display name, e.g. "Color palette 1" (the user can change it).
   * @property {HTMLInputElement} nameInput The editable name field.
   * @property {string[]} colors Hex codes in the order they were added (at most
   *   `MAX_COLORS_PER_PALETTE`).
   * @property {HTMLElement} card The palette's element.
   * @property {HTMLElement} columns The row of color columns inside the card.
   * @property {HTMLElement} count The "3 of 5 colors" label.
   * @property {HTMLButtonElement} addButton The "Add color" button.
   * @property {HTMLButtonElement} deleteButton The "Delete palette" button.
   * @property {?number} confirmTimer Timer id while the delete button waits for its second
   *   click, otherwise `null`.
   */

  /**
   * Redraws a palette's columns: one filled column per color (hex code printed on it, in
   * a readable text color) followed by dashed empty slots up to the maximum, and refreshes
   * the count label and the "Add color" button.
   * @param {Palette} palette @returns {void}
   */
  function renderPalette(palette) {
    resetDeleteConfirm(palette, MESSAGE.DELETE_PALETTE);   // any change cancels a pending delete
    palette.columns.textContent = '';
    for (let index = 0; index < MAX_COLORS_PER_PALETTE; index++) {
      const hex = palette.colors[index];
      if (!hex) {
        palette.columns.appendChild(createElementWith('div', CLASS.PALETTE_SLOT));
        continue;
      }
      const tone = isLightColor(hex) ? CLASS.LIGHT : CLASS.DARK;
      const column = createElementWith('div', CLASS.PALETTE_COLOR + ' ' + tone);
      column.style.background = hex;
      column.dataset.index = String(index);
      column.title = hex;
      column.appendChild(createElementWith('span', CLASS.PALETTE_HEX, hex));

      const removeButton = createElementWith('button', CLASS.PALETTE_COLOR_DELETE, MESSAGE.REMOVE_GLYPH);
      removeButton.type = 'button';
      removeButton.setAttribute('aria-label', MESSAGE.deleteColorLabel(hex));
      removeButton.addEventListener('click', () => {
        removeColor(palette, index);
        palette.addButton.focus();        // the clicked button is gone: keep keyboard focus useful
      });
      column.appendChild(removeButton);
      palette.columns.appendChild(column);
    }
    palette.count.textContent = MESSAGE.paletteCount(palette.colors.length);
    palette.addButton.disabled = palette.colors.length >= MAX_COLORS_PER_PALETTE;
  }

  /**
   * Builds a new, empty palette card. Right-clicking a color offers to delete that color;
   * right-clicking anywhere else on the card offers to delete the whole palette.
   * @param {string} [savedName] The name it was saved with; new palettes get the next free
   *   "Color palette N".
   * @param {string[]} [savedColors] Colors it was saved with.
   * @returns {Palette}
   */
  function createPalette(savedName, savedColors) {
    const name = savedName || nextFreeName(state.palettes.map(palette => palette.name), MESSAGE.paletteTitle);

    const card = createElementWith('div', CLASS.PALETTE);
    const header = createElementWith('div', CLASS.PALETTE_HEADER);
    const tools = createElementWith('div', CLASS.PALETTE_TOOLS);
    const count = createElementWith('span', CLASS.PALETTE_COUNT);
    const addButton = createElementWith(
      'button', [CLASS.BUTTON, CLASS.PRIMARY, CLASS.SMALL].join(' '), MESSAGE.ADD_COLOR);
    addButton.type = 'button';
    const deleteButton = createElementWith(
      'button', [CLASS.BUTTON, CLASS.GHOST, CLASS.SMALL].join(' '), MESSAGE.DELETE_PALETTE);
    deleteButton.type = 'button';
    tools.appendChild(count);
    tools.appendChild(addButton);
    tools.appendChild(deleteButton);
    const title = createElementWith('h3', CLASS.PALETTE_TITLE);
    const nameInput = createNameField(CLASS.PALETTE_NAME, name, MESSAGE.PALETTE_NAME_LABEL);
    title.appendChild(nameInput);
    header.appendChild(title);
    header.appendChild(tools);

    const columns = createElementWith('div', CLASS.PALETTE_COLUMNS);
    columns.style.gridTemplateColumns = 'repeat(' + MAX_COLORS_PER_PALETTE + ', 1fr)';
    card.appendChild(header);
    card.appendChild(columns);

    /** @type {Palette} */
    const palette = {
      name, nameInput, colors: savedColors ? savedColors.slice() : [], card, columns, count, addButton,
      deleteButton, confirmTimer: null
    };
    wireNameField(palette, () => scheduleSave(RECORD.PALETTES));
    addButton.addEventListener('click', () => openColorDialog(palette));
    deleteButton.addEventListener('click', () =>
      requestDelete(palette, MESSAGE.DELETE_PALETTE, palette.colors.length > 0, () => {
        deletePalette(palette.card);
        el.newPaletteButton.focus();        // the palette (and its button) is gone
      }));
    card.addEventListener('contextmenu', event => {
      if (event.target === nameInput) return;   // leave the browser's text menu for renaming
      const column = event.target.closest('.' + CLASS.PALETTE_COLOR);
      openContextMenu(event, column || card);
    });
    renderPalette(palette);
    return palette;
  }

  /**
   * Adds a new empty palette at the top of the list.
   * @returns {void}
   */
  function addPalette() {
    const palette = createPalette();
    state.palettes.unshift(palette);
    el.palettesList.prepend(palette.card);
    el.palettesEmpty.hidden = true;
    el.palettesList.hidden = false;
    scheduleSave(RECORD.PALETTES);
  }

  /**
   * Adds a color to a palette unless it is already full.
   * @param {Palette} palette @param {string} hex A normalized `#RRGGBB` code.
   * @returns {boolean} Whether the color was added.
   */
  function addColorToPalette(palette, hex) {
    if (palette.colors.length >= MAX_COLORS_PER_PALETTE) return false;
    palette.colors.push(hex);
    renderPalette(palette);
    scheduleSave(RECORD.PALETTES);
    return true;
  }

  /**
   * Finds the palette whose card or column row contains an element.
   * @param {HTMLElement} element A palette card or one of its color columns.
   * @returns {?Palette}
   */
  function findPalette(element) {
    return state.palettes.find(palette =>
      palette.card === element || palette.columns === element.parentNode) || null;
  }

  /**
   * Removes the color at a position from a palette.
   * @param {Palette} palette @param {number} index Position in `palette.colors`.
   * @returns {void}
   */
  function removeColor(palette, index) {
    palette.colors.splice(index, 1);
    renderPalette(palette);
    scheduleSave(RECORD.PALETTES);
  }

  /**
   * Removes one color, from the right-click menu.
   * @param {HTMLElement} column The palette color column that was right-clicked.
   * @returns {void}
   */
  function deletePaletteColor(column) {
    const palette = findPalette(column);
    if (palette) removeColor(palette, Number(column.dataset.index));
  }

  /**
   * Removes a whole palette and restores the empty message if none are left.
   * @param {HTMLElement} card The palette card.
   * @returns {void}
   */
  function deletePalette(card) {
    const doomed = state.palettes.find(palette => palette.card === card);
    if (doomed) clearTimeout(doomed.confirmTimer);
    state.palettes = state.palettes.filter(palette => palette.card !== card);
    card.remove();
    if (state.palettes.length === 0) {
      el.palettesList.hidden = true;
      el.palettesEmpty.hidden = false;
    }
    scheduleSave(RECORD.PALETTES);
  }

  // ------------------------------------------------------------- add-color dialog

  /** The wheel picture is cached so dragging on it doesn't re-render every pixel per move. */
  const wheelCache = { size: 0, value: -1, image: null };

  /**
   * Whether the add-color dialog is showing.
   * @returns {boolean}
   */
  function isColorDialogOpen() {
    return !el.colorDialog.hidden;
  }

  /**
   * Sizes the wheel's drawing surface to its on-screen size (times the screen's pixel
   * ratio, so it stays sharp on high-density displays).
   * @returns {void}
   */
  function sizeWheelCanvas() {
    const cssWidth = el.colorWheel.getBoundingClientRect().width;
    const pixels = Math.max(1, Math.round(cssWidth * (window.devicePixelRatio || 1)));
    el.colorWheel.width = pixels;
    el.colorWheel.height = pixels;
  }

  /**
   * Draws the wheel at the current brightness plus a marker at the current color.
   * @returns {void}
   */
  function drawWheel() {
    const canvas = el.colorWheel;
    const size = canvas.width;
    if (!size) return;
    const ctx = canvas.getContext('2d');
    const { h, s, v } = state.color;

    if (wheelCache.size !== size || wheelCache.value !== v) {
      const image = ctx.createImageData(size, size);
      image.data.set(renderWheelPixels(size, v));
      wheelCache.size = size;
      wheelCache.value = v;
      wheelCache.image = image;
    }
    ctx.putImageData(wheelCache.image, 0, 0);

    const radius = size * HALF;
    const pixelsPerCssPx = size / canvas.getBoundingClientRect().width;
    const point = hueSatToWheelPoint(h, s, radius);
    ctx.beginPath();
    ctx.arc(radius + point.x, radius + point.y, WHEEL_MARKER_RADIUS_PX * pixelsPerCssPx, 0, FULL_CIRCLE_RAD);
    ctx.fillStyle = rgbToHex(hsvToRgb(h, s, v));
    ctx.fill();
    ctx.lineWidth = WHEEL_MARKER_RING_PX * WHEEL_MARKER_OUTLINE_FACTOR * pixelsPerCssPx;
    ctx.strokeStyle = WHEEL_MARKER_OUTLINE_COLOR;
    ctx.stroke();
    ctx.lineWidth = WHEEL_MARKER_RING_PX * pixelsPerCssPx;
    ctx.strokeStyle = WHEEL_MARKER_RING_COLOR;
    ctx.stroke();
  }

  /**
   * Makes `hsv` the dialog's current color and updates every control except the one the
   * change came from (so typing in the hex box isn't overwritten mid-word).
   * @param {{h: number, s: number, v: number}} hsv
   * @param {string} source One of `SOURCE`.
   * @returns {void}
   */
  function applyColor(hsv, source) {
    state.color = hsv;
    const hex = rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v));
    el.colorPreview.style.background = hex;
    if (source !== SOURCE.HEX) el.colorHex.value = hex;
    if (source !== SOURCE.SLIDER) el.colorValue.value = String(Math.round(hsv.v * Number(el.colorValue.max)));
    el.colorError.textContent = '';
    drawWheel();
  }

  /**
   * Chooses hue and saturation from a pointer position on the wheel.
   * @param {PointerEvent} event @returns {void}
   */
  function pickFromWheel(event) {
    const canvas = el.colorWheel;
    const rect = canvas.getBoundingClientRect();
    const pixelsPerCssPx = canvas.width / rect.width;
    const radius = canvas.width * HALF;
    const x = (event.clientX - rect.left) * pixelsPerCssPx - radius;
    const y = (event.clientY - rect.top) * pixelsPerCssPx - radius;
    const { h, s } = wheelPointToHueSat(x, y, radius);
    applyColor({ h, s, v: state.color.v }, SOURCE.WHEEL);
  }

  /**
   * Opens the add-color dialog for a palette (starting from the last color used).
   * @param {Palette} palette @returns {void}
   */
  function openColorDialog(palette) {
    closeContextMenu();
    state.colorDialog = { palette, opener: palette.addButton };
    el.colorDialogTitle.textContent = MESSAGE.addColorTo(palette.name);
    el.colorDialog.hidden = false;
    sizeWheelCanvas();
    applyColor(state.color, SOURCE.OPEN);
    el.colorDialogPanel.focus();
  }

  /**
   * Closes the dialog and returns focus to the button that opened it.
   * @returns {void}
   */
  function closeColorDialog() {
    if (!isColorDialogOpen()) return;
    el.colorDialog.hidden = true;
    if (state.colorDialog) state.colorDialog.opener.focus();
    state.colorDialog = null;
  }

  /**
   * Adds the color in the hex box to the palette and closes the dialog, or explains what
   * is wrong with the hex code.
   * @returns {void}
   */
  function confirmColor() {
    const hex = normalizeHex(el.colorHex.value);
    if (!hex) {
      el.colorError.textContent = MESSAGE.INVALID_HEX;
      el.colorHex.focus();
      return;
    }
    if (state.colorDialog) addColorToPalette(state.colorDialog.palette, hex);
    closeColorDialog();
    scheduleSave(RECORD.SETTINGS);          // remembers this as the last color used
  }

  /**
   * Wires the dialog: dragging on the wheel, the brightness slider, the hex box (Enter
   * confirms), the buttons, a click on the backdrop, Escape, and the Tab focus trap.
   * @returns {void}
   */
  function wireColorDialog() {
    let draggingWheel = false;
    el.colorWheel.addEventListener('pointerdown', event => {
      if (event.button !== PRIMARY_BUTTON) return;
      draggingWheel = true;
      el.colorWheel.setPointerCapture(event.pointerId);
      pickFromWheel(event);
    });
    el.colorWheel.addEventListener('pointermove', event => { if (draggingWheel) pickFromWheel(event); });
    const stopDragging = () => { draggingWheel = false; };
    el.colorWheel.addEventListener('pointerup', stopDragging);
    el.colorWheel.addEventListener('pointercancel', stopDragging);

    el.colorValue.addEventListener('input', () => {
      const value = Number(el.colorValue.value) / Number(el.colorValue.max);
      applyColor({ h: state.color.h, s: state.color.s, v: value }, SOURCE.SLIDER);
    });
    el.colorHex.addEventListener('input', () => {
      const hex = normalizeHex(el.colorHex.value);
      if (hex) applyColor(rgbToHsv(hexToRgb(hex)), SOURCE.HEX);
    });
    el.colorHex.addEventListener('keydown', event => {
      if (event.key !== KEY.ENTER) return;
      event.preventDefault();
      confirmColor();
    });

    el.colorConfirm.addEventListener('click', confirmColor);
    el.colorCancel.addEventListener('click', closeColorDialog);
    el.colorDialog.addEventListener('click', event => {
      if (event.target === el.colorDialog) closeColorDialog(); // backdrop only, not the panel
    });

    document.addEventListener('keydown', event => {
      if (!isColorDialogOpen()) return;
      if (event.key === KEY.ESCAPE) closeColorDialog();
      else if (event.key === KEY.TAB) {
        trapTabFocus(event, [el.colorValue, el.colorHex, el.colorCancel, el.colorConfirm]);
      }
    });
  }

  // ------------------------------------------------------------------- color drop

  /**
   * Displays a picked color (swatch plus selectable hex code) next to the toolbar.
   * @param {string} hex A normalized `#RRGGBB` code. @returns {void}
   */
  function displayPickedColor(hex) {
    el.pickedSwatch.style.background = hex;
    el.pickedHex.value = hex;
    el.picked.hidden = false;
  }

  /**
   * Shows a color the user just picked, announces it, and remembers it.
   * @param {string} hex A normalized `#RRGGBB` code. @returns {void}
   */
  function showPickedColor(hex) {
    displayPickedColor(hex);
    setStatus(MESSAGE.picked(hex));
    scheduleSave(RECORD.SETTINGS);
  }

  /**
   * Reads the color of the picture pixel under the pointer.
   * @param {HTMLElement} piece A piece on the table.
   * @param {{clientX: number, clientY: number}} point Pointer position.
   * @returns {?string} `#RRGGBB`, or `null` where the piece is transparent.
   */
  function sampleColorFromPiece(piece, point) {
    const image = piece.querySelector('img');
    const rect = piece.getBoundingClientRect();
    // Map the pointer to a pixel of the picture (which is shown scaled to the piece's box).
    const fractionX = (point.clientX - rect.left) / rect.width;
    const fractionY = (point.clientY - rect.top) / rect.height;
    const clampTo = (value, max) => Math.min(max - 1, Math.max(0, Math.floor(value)));
    const sourceX = clampTo(fractionX * image.naturalWidth, image.naturalWidth);
    const sourceY = clampTo(fractionY * image.naturalHeight, image.naturalHeight);

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, sourceX, sourceY, 1, 1, 0, 0, 1, 1);
    const [r, g, b, alpha] = ctx.getImageData(0, 0, 1, 1).data;
    return alpha < MIN_PICKABLE_ALPHA ? null : rgbToHex([r, g, b]);
  }

  /**
   * Finishes waiting for a click on a piece.
   * @returns {void}
   */
  function endPiecePicking() {
    if (!state.pickingColor) return;
    state.pickingColor = false;
    el.workspace.classList.remove(CLASS.PICKING);
    el.colorDropButton.setAttribute('aria-pressed', 'false');
    setStatus('');
  }

  /**
   * Waits for the user to click a piece (used where the browser has no eyedropper).
   * @returns {void}
   */
  function beginPiecePicking() {
    if (state.pieceCount === 0) { setStatus(MESSAGE.NOTHING_TO_PICK); return; }
    state.pickingColor = true;
    el.workspace.classList.add(CLASS.PICKING);
    el.colorDropButton.setAttribute('aria-pressed', 'true');
    setStatus(MESSAGE.PICK_HINT);
  }

  /**
   * Handles the click that completes a pick from a piece.
   * @param {HTMLElement} piece @param {PointerEvent} event @returns {void}
   */
  function pickColorFromPiece(piece, event) {
    const hex = sampleColorFromPiece(piece, event);
    if (!hex) { setStatus(MESSAGE.TRANSPARENT_SPOT); return; }
    endPiecePicking();
    showPickedColor(hex);
  }

  /**
   * The color drop tool. Browsers that support the EyeDropper API let the user pick any
   * pixel on screen; elsewhere (or if the API is blocked, e.g. in an embedded frame) the
   * user clicks a piece on the table instead. Clicking the button again cancels.
   * @returns {Promise<void>}
   */
  async function startColorDrop() {
    if (state.pickingColor) { endPiecePicking(); return; }
    if (typeof window.EyeDropper === 'function') {
      try {
        const result = await new window.EyeDropper().open();
        const hex = normalizeHex(result.sRGBHex);
        if (hex) showPickedColor(hex);
        return;
      } catch (error) {
        if (error && error.name === ABORT_ERROR_NAME) return; // the user cancelled
        // Not allowed here: fall back to picking from the pieces.
      }
    }
    beginPiecePicking();
  }

  /**
   * Copies the picked hex code, or selects it so the user can copy it by hand.
   * @returns {Promise<void>}
   */
  async function copyPickedColor() {
    const hex = el.pickedHex.value;
    try {
      await navigator.clipboard.writeText(hex);
      setStatus(MESSAGE.copied(hex));
    } catch (error) {
      el.pickedHex.select();
      setStatus(MESSAGE.COPY_MANUALLY);
    }
  }

  /**
   * Wires the Color drop button, the Copy button, and the ways to cancel picking from a
   * piece (Escape, or a click on bare table).
   * @returns {void}
   */
  function wireColorDrop() {
    el.colorDropButton.addEventListener('click', startColorDrop);
    el.pickedCopy.addEventListener('click', copyPickedColor);
    document.addEventListener('keydown', event => {
      if (event.key === KEY.ESCAPE) endPiecePicking();
    });
    el.workspace.addEventListener('pointerdown', event => {
      if (event.target === el.workspace || el.emptyState.contains(event.target)) endPiecePicking();
    });
  }

  // ---------------------------------------------------------- saving and restoring

  /**
   * The browser's IndexedDB factory, or `undefined` where it is missing or blocked
   * (some privacy modes and sandboxed frames even throw when it is touched).
   * @returns {(IDBFactory|undefined)}
   */
  function findIndexedDb() {
    try { return window.indexedDB; } catch (error) { return undefined; }
  }

  const store = Store.createStore(findIndexedDb());

  /** Records waiting to be written, and the timer that will write them. */
  const pendingSaves = new Set();
  let saveTimer = null;

  /**
   * Shows a storage problem once (not on every later save attempt).
   * @param {string} message @returns {void}
   */
  function warnOnce(message) {
    if (state.storageWarned) return;
    state.storageWarned = true;
    setStatus(message);
  }

  // ---- what gets saved

  /**
   * Saved palettes: names and colors, in display order.
   * @returns {{version: number, palettes: {name: string, colors: string[]}[]}}
   */
  function buildPalettesRecord() {
    return {
      version: SCHEMA_VERSION,
      palettes: state.palettes.map(palette => ({ name: palette.name, colors: palette.colors.slice() }))
    };
  }

  /**
   * Saved outfits: name, picture and piece count, in display order.
   * @returns {{version: number, outfits: {name: string, imageUrl: string, pieceCount: number}[]}}
   */
  function buildOutfitsRecord() {
    return {
      version: SCHEMA_VERSION,
      outfits: state.outfits.map(outfit => ({
        name: outfit.name, imageUrl: outfit.imageUrl, pieceCount: outfit.pieceCount
      }))
    };
  }

  /**
   * The pieces on the table: picture, position, size and stacking order.
   * @returns {{version: number, pieces: Object[]}}
   */
  function buildTableRecord() {
    const pieces = Array.from(el.workspace.querySelectorAll('.' + CLASS.PIECE)).map(piece => ({
      src: piece.querySelector('img').src,
      left: piece.offsetLeft,
      top: piece.offsetTop,
      width: piece.offsetWidth,
      height: piece.offsetHeight,
      z: parseInt(piece.style.zIndex, DECIMAL_RADIX) || BASE_Z_INDEX
    }));
    return { version: SCHEMA_VERSION, pieces };
  }

  /**
   * Small settings: the color the color drop picked, the last color added to a palette,
   * and the open tab.
   * @returns {{version: number, pickedColor: ?string, lastColor: string, tab: string}}
   */
  function buildSettingsRecord() {
    return {
      version: SCHEMA_VERSION,
      pickedColor: el.picked.hidden ? null : el.pickedHex.value,
      lastColor: rgbToHex(hsvToRgb(state.color.h, state.color.s, state.color.v)),
      tab: state.tab
    };
  }

  const RECORD_BUILDERS = Object.freeze({
    [RECORD.PALETTES]: buildPalettesRecord,
    [RECORD.OUTFITS]: buildOutfitsRecord,
    [RECORD.TABLE]: buildTableRecord,
    [RECORD.SETTINGS]: buildSettingsRecord
  });

  // ---- writing

  /**
   * Writes one record now, warning (once) if the browser refuses.
   * @param {string} record One of `RECORD`. @returns {void}
   */
  function writeRecord(record) {
    store.set(record, RECORD_BUILDERS[record]()).then(saved => {
      if (!saved) warnOnce(MESSAGE.SAVE_FAILED);
    });
  }

  /**
   * Writes every record that changed. Also runs when the page is hidden or closed, so a
   * refresh right after a change doesn't lose it.
   * @returns {void}
   */
  function flushSaves() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const records = Array.from(pendingSaves);
    pendingSaves.clear();
    records.forEach(writeRecord);
  }

  /**
   * Notes that a record changed and will be saved shortly. Rapid changes (like dragging)
   * are batched into one write. Nothing is saved until the earlier data has been loaded,
   * so starting up can never overwrite it with an empty page.
   * @param {string} record One of `RECORD`. @returns {void}
   */
  function scheduleSave(record) {
    if (!state.restored || !state.storageAvailable) return;
    pendingSaves.add(record);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaves, SAVE_DELAY_MS);
  }

  // ---- reading back (saved data is untrusted: check every field)

  /**
   * @param {*} record A record read from storage.
   * @returns {?Object} The record if it is an object of the current version, else `null`.
   */
  function readCurrentRecord(record) {
    return record && typeof record === 'object' && record.version === SCHEMA_VERSION ? record : null;
  }

  /**
   * @param {*} value A saved name. @returns {?string} The trimmed, length-limited name, or
   *   `null` if it isn't usable.
   */
  function readName(value) {
    const text = typeof value === 'string' ? value.trim().slice(0, MAX_NAME_LENGTH) : '';
    return text || null;
  }

  /**
   * @param {*} value A saved picture. @returns {?string} The value if it is an image data URL.
   */
  function readImageUrl(value) {
    return typeof value === 'string' && value.startsWith(IMAGE_DATA_URL_PREFIX) ? value : null;
  }

  /**
   * @param {*} value A saved count. @returns {number} The count, or 0 if it isn't a whole
   *   number of at least zero.
   */
  function readCount(value) {
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  /**
   * Turns a saved piece into a layout that fits the table as it is now.
   * @param {Object} saved A saved piece. @param {{width: number, height: number}} table
   * @returns {(PieceLayout|undefined)} `undefined` if its numbers are unusable, in which
   *   case the piece is laid out afresh.
   */
  function readLayout(saved, table) {
    const box = { x: saved.left, y: saved.top, w: saved.width, h: saved.height };
    const usable = Object.values(box).every(Number.isFinite) && box.w > 0 && box.h > 0;
    if (!usable) return undefined;
    const fitted = table.width && table.height ? fitBoxInsideTable(box, table) : box;
    const z = Number.isFinite(saved.z) ? saved.z : BASE_Z_INDEX;
    return { x: fitted.x, y: fitted.y, w: fitted.w, h: fitted.h, z };
  }

  /**
   * Rebuilds the saved palettes.
   * @param {*} record The saved palettes record. @returns {void}
   */
  function restorePalettes(record) {
    const data = readCurrentRecord(record);
    if (!data || !Array.isArray(data.palettes)) return;
    data.palettes.forEach(saved => {
      if (!saved || typeof saved !== 'object') return;
      const colors = (Array.isArray(saved.colors) ? saved.colors : [])
        .map(normalizeHex).filter(Boolean).slice(0, MAX_COLORS_PER_PALETTE);
      const palette = createPalette(readName(saved.name), colors);
      state.palettes.push(palette);
      el.palettesList.appendChild(palette.card);
    });
    if (state.palettes.length > 0) {
      el.palettesEmpty.hidden = true;
      el.palettesList.hidden = false;
    }
  }

  /**
   * Rebuilds the saved outfits.
   * @param {*} record The saved outfits record. @returns {void}
   */
  function restoreOutfits(record) {
    const data = readCurrentRecord(record);
    if (!data || !Array.isArray(data.outfits)) return;
    data.outfits.forEach(saved => {
      const imageUrl = saved && readImageUrl(saved.imageUrl);
      if (!imageUrl) return;
      const outfit = createOutfit(imageUrl, readCount(saved.pieceCount), readName(saved.name));
      state.outfits.push(outfit);
      el.outfitsGrid.appendChild(outfit.card);
    });
    if (state.outfits.length > 0) {
      el.outfitsEmpty.hidden = true;
      el.outfitsHint.hidden = false;
      el.outfitsGrid.hidden = false;
    }
  }

  /**
   * Puts the saved pieces back on the table.
   * @param {*} record The saved table record. @returns {void}
   */
  function restoreTable(record) {
    const data = readCurrentRecord(record);
    if (!data || !Array.isArray(data.pieces)) return;
    const table = { width: el.workspace.clientWidth, height: el.workspace.clientHeight };
    data.pieces
      .map(saved => ({ saved, src: saved && readImageUrl(saved.src) }))
      .filter(entry => entry.src)                 // drop unusable entries first, then cap the rest
      .slice(0, MAX_PIECES)
      .forEach(entry => addToWorkspace(entry.src, readLayout(entry.saved, table)));
  }

  /**
   * Restores the picked color and the last color used in the add-color dialog.
   * @param {*} record The saved settings record. @returns {void}
   */
  function restoreColors(record) {
    const data = readCurrentRecord(record);
    if (!data) return;
    const picked = normalizeHex(data.pickedColor);
    if (picked) displayPickedColor(picked);
    const last = normalizeHex(data.lastColor);
    if (last) state.color = rgbToHsv(hexToRgb(last));
  }

  /**
   * Reopens the tab the user was on.
   * @param {*} record The saved settings record. @returns {void}
   */
  function restoreTab(record) {
    const data = readCurrentRecord(record);
    if (data && Object.values(TAB).includes(data.tab)) showTab(data.tab);
  }

  /**
   * Runs one restore step; a damaged record must not stop the others from loading.
   * @param {() => void} step @returns {void}
   */
  function runSafely(step) {
    try { step(); } catch (error) { /* skip the damaged record */ }
  }

  /**
   * Loads everything saved earlier and rebuilds the page from it. If the browser blocks
   * storage the page still works, and the user is told once that nothing will be kept.
   * @returns {Promise<void>}
   */
  async function restore() {
    if (!(await store.isAvailable())) {
      state.storageAvailable = false;
      state.restored = true;
      warnOnce(MESSAGE.STORAGE_UNAVAILABLE);
      return;
    }
    const keys = Object.values(RECORD);
    const values = await Promise.all(keys.map(key => store.get(key)));
    const saved = {};
    keys.forEach((key, index) => { saved[key] = values[index]; });

    runSafely(() => restorePalettes(saved[RECORD.PALETTES]));
    runSafely(() => restoreOutfits(saved[RECORD.OUTFITS]));
    runSafely(() => restoreColors(saved[RECORD.SETTINGS]));
    runSafely(() => restoreTable(saved[RECORD.TABLE]));     // while the Home tab is showing
    runSafely(() => restoreTab(saved[RECORD.SETTINGS]));
    state.restored = true;
    updateCounter();
  }

  /**
   * Saves pending changes when the page is hidden or closed.
   * @returns {void}
   */
  function wireSaving() {
    window.addEventListener('pagehide', flushSaves);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSaves();
    });
  }

  // ------------------------------------------------------------------------- tabs

  const tabButtons = Array.from(document.querySelectorAll('nav [role="tab"]'));
  const panels = {
    [TAB.HOME]: byId('panel-home'),
    [TAB.OUTFITS]: byId('panel-outfits'),
    [TAB.PALETTES]: byId('panel-palettes')
  };

  /**
   * Shows one tab's panel (hiding the others) and remembers the choice.
   * @param {string} name One of `TAB`. @returns {void}
   */
  function showTab(name) {
    endPiecePicking();
    tabButtons.forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === name)));
    Object.keys(panels).forEach(panelName => { panels[panelName].hidden = panelName !== name; });
    state.tab = name;
    scheduleSave(RECORD.SETTINGS);
  }

  /**
   * Wires the header tabs so only the chosen panel is visible.
   * @returns {void}
   */
  function wireTabs() {
    tabButtons.forEach(button => {
      button.addEventListener('click', () => showTab(button.dataset.tab));
    });
  }

  // ------------------------------------------------------------------------- start

  /**
   * Connects every part of the page, shows the initial (empty) state, then loads whatever
   * was saved earlier.
   * @returns {void}
   */
  function init() {
    wireContextMenu();
    wireViewer();
    wireColorDialog();
    wireColorDrop();
    wireUploads();
    wireTabs();
    wireSaving();
    el.newPaletteButton.addEventListener('click', addPalette);
    el.saveButton.addEventListener('click', saveOutfit);
    el.clearButton.addEventListener('click', clearTable);
    updateCounter();
    restore().catch(() => { state.restored = true; });   // never let loading break the page
  }

  init();
})();
