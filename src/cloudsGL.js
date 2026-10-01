import { permutationImage } from './noise.js';
import { CLOUD_SHADER_CONSTANTS, cloudNoiseOrigins } from './skyImage.js';

/*
 * Draws the cloud layers with WebGL 1, which even a Raspberry Pi's GPU can do
 * in a few milliseconds. The fragment shader is a port of renderClouds in
 * skyImage.js (same noise, same cloud shape, same lighting), fed with its
 * per-row colors from cloudShaderData. New frames fade in on the GPU: frames
 * are drawn into textures, and the canvas shows the old and new ones blended,
 * with premultiplied colors so what's shown stays between the two frames.
 */

const {
  COVER_SOFTNESS,
  EDGE_ZONE,
  EDGE_FREQUENCY,
  EDGE_SOFTNESS,
  EDGE_GLOW_ZONES_PER_UNIT,
  BLACK_LEVEL,
  GLOW_ENCODE_RANGE,
  ROW_TEXELS,
  SCATTERING_LUT_SIZE,
} = CLOUD_SHADER_CONSTANTS;
const MAX_LAYERS = 3;
const float = (value) => (Number.isInteger(value) ? `${value}.0` : String(value));

const VERTEX_SHADER = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const CLOUD_SHADER = `
precision highp float;
uniform sampler2D permutation;
uniform sampler2D rows;
uniform sampler2D scatteringLut;
uniform float height;
uniform float cloudMaxOpacity;
uniform float scattering;
uniform float glowWidth;
uniform float rimDepth;
uniform float thickness;
uniform float depthNeeded;
uniform float boost;
uniform float boostContrast;
uniform vec4 layerBand[${MAX_LAYERS}];    // bottom, top, cover, threshold
uniform vec4 layerNoise[${MAX_LAYERS}];   // frequency x, frequency y, boost share, showing
uniform vec4 layerOrigin[${MAX_LAYERS}];  // density x, density y, lumps x, lumps y

const vec3 BLACK_LEVEL = vec3(${BLACK_LEVEL.map((v) => float(v / 255)).join(', ')});
const vec3 LUMINANCE = vec3(0.2126, 0.7152, 0.0722);

vec4 permutationAt(float i) {
  return texture2D(permutation, vec2((i + 0.5) / 512.0, 0.5));
}
float tableValue(float i) {
  return floor(permutationAt(i).r * 255.0 + 0.5);
}
vec2 gradientAt(float i) {
  return floor(permutationAt(i).gb * (255.0 / 127.0) + 0.5) - 1.0;
}
float fade(float t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}
// The same 2D gradient noise as perlin() in noise.js
float perlin(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = p - cell;
  float xi = mod(cell.x, 256.0);
  float yi = mod(cell.y, 256.0);
  float a = tableValue(xi) + yi;
  float b = tableValue(xi + 1.0) + yi;
  float u = fade(f.x);
  float v = fade(f.y);
  float bottom = mix(dot(gradientAt(a), f), dot(gradientAt(b), f - vec2(1.0, 0.0)), u);
  float top = mix(dot(gradientAt(a + 1.0), f - vec2(0.0, 1.0)), dot(gradientAt(b + 1.0), f - vec2(1.0)), u);
  return mix(bottom, top, v);
}
// fractalNoise() in noise.js, with 5 and 3 octaves
float fractal5(vec2 p) {
  float sum = 0.0;
  float strength = 1.0;
  float frequency = 1.0;
  for (int octave = 0; octave < 5; octave++) {
    sum += strength * perlin(p * frequency);
    strength *= 0.5;
    frequency *= 2.0;
  }
  return 0.5 + 0.5 * sum / 1.9375;
}
float fractal3(vec2 p) {
  float sum = 0.0;
  float strength = 1.0;
  float frequency = 1.0;
  for (int octave = 0; octave < 3; octave++) {
    sum += strength * perlin(p * frequency);
    strength *= 0.5;
    frequency *= 2.0;
  }
  return 0.5 + 0.5 * sum / 1.75;
}

vec3 encodeSrgb(vec3 linear) {
  vec3 low = 12.92 * linear;
  vec3 high = 1.055 * pow(max(linear, 0.0031308), vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, vec3(lessThanEqual(linear, vec3(0.0031308))));
}
vec3 decodeSrgb(vec3 encoded) {
  vec3 low = encoded / 12.92;
  vec3 high = pow((encoded + 0.055) / 1.055, vec3(2.4));
  return mix(high, low, vec3(lessThanEqual(encoded, vec3(0.04045))));
}
// toScreenValue() in skyImage.js, as 0–1
vec3 toScreen(vec3 linear) {
  return BLACK_LEVEL + (1.0 - BLACK_LEVEL) * encodeSrgb(linear);
}
float maxOf(vec3 v) {
  return max(v.r, max(v.g, v.b));
}

void main() {
  float up = gl_FragCoord.y / height;
  float x = gl_FragCoord.x / height;
  float rowY = gl_FragCoord.y / height;

  // The layer whose band this row is in
  vec4 band = vec4(0.0);
  vec4 noise = vec4(0.0);
  vec4 origin = vec4(0.0);
  for (int i = 0; i < ${MAX_LAYERS}; i++) {
    if (noise.w < 0.5 && layerNoise[i].w > 0.5 && up >= layerBand[i].x && up < layerBand[i].y) {
      band = layerBand[i];
      noise = layerNoise[i];
      origin = layerOrigin[i];
    }
  }
  if (noise.w < 0.5 || cloudMaxOpacity <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // cloudShape() in skyImage.js
  float cover = band.z;
  float threshold = band.w;
  float opacity = 1.0;
  float thinness = 0.0;
  float depth = 1000.0;
  if (cover < 1.0) {
    float density = fractal5(vec2(x * noise.x + origin.x, up * noise.y + origin.y));
    float edge = threshold - ${float(COVER_SOFTNESS)};
    opacity = smoothstep(edge, threshold + ${float(COVER_SOFTNESS)}, density);
    if (opacity <= 0.0) {
      gl_FragColor = vec4(0.0);
      return;
    }
    thinness = 1.0 - smoothstep(edge, threshold + glowWidth, density);
    depth = density - edge;
  }
  float withinBand = (up - band.x) / (band.y - band.x);
  float edgeDistance = min(withinBand, 1.0 - withinBand) / ${float(EDGE_ZONE)};
  float edgeGlowDepth = max(glowWidth, depthNeeded) * ${float(EDGE_GLOW_ZONES_PER_UNIT)};
  if (edgeDistance < ${float(1 + EDGE_SOFTNESS)} + edgeGlowDepth) {
    float lump = fractal3(vec2(x * ${float(EDGE_FREQUENCY)} + origin.z, up * ${float(EDGE_FREQUENCY)} + origin.w));
    float reach = clamp(0.5 + (0.5 - lump) * 2.0, 0.0, 1.0);
    opacity *= smoothstep(reach - ${float(EDGE_SOFTNESS)}, reach + ${float(EDGE_SOFTNESS)}, edgeDistance);
    float edgeThinness =
      1.0 - smoothstep(reach - ${float(EDGE_SOFTNESS)}, reach + ${float(EDGE_SOFTNESS)} + edgeGlowDepth, edgeDistance);
    thinness = max(thinness, edgeThinness);
    depth = min(depth, max(0.0, (edgeDistance - (reach - ${float(EDGE_SOFTNESS)})) / ${float(EDGE_GLOW_ZONES_PER_UNIT)}));
  }
  if (glowWidth <= 0.0) thinness = 0.0;

  // The rest of renderClouds()
  vec4 skyTexel = texture2D(rows, vec2(0.5 / ${float(ROW_TEXELS)}, rowY));
  float alpha = cloudMaxOpacity * opacity;
  if (alpha <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 light;
  if (scattering > 0.5) {
    float tau = min(thickness, exp(min(depth / rimDepth, 60.0)) - 1.0);
    alpha = cloudMaxOpacity * (1.0 - exp(-tau));
    float s = log(tau + 1.0) / log(thickness + 1.0);
    float lutX = (s * ${float(SCATTERING_LUT_SIZE - 1)} + 0.5) / ${float(SCATTERING_LUT_SIZE)};
    light = decodeSrgb(texture2D(scatteringLut, vec2(lutX, rowY)).rgb);
  } else {
    vec3 cloud = decodeSrgb(texture2D(rows, vec2(1.5 / ${float(ROW_TEXELS)}, rowY)).rgb);
    vec4 glowTexel = texture2D(rows, vec2(2.5 / ${float(ROW_TEXELS)}, rowY));
    vec3 glow = decodeSrgb(glowTexel.rgb) * ${float(GLOW_ENCODE_RANGE)};
    float match = glowTexel.a;
    light = cloud + glow * thinness;
    float peak = maxOf(light);
    vec3 capped = min(light, vec3(1.0));
    light = peak > 1.0 ? capped + (light / peak - capped) * match : capped;

    // The boost layer, in a color blend
    float boostShare = noise.z;
    if (boost > 0.0 && boostShare > 0.0 && thinness > 0.0) {
      vec3 boostColor = decodeSrgb(texture2D(rows, vec2(3.5 / ${float(ROW_TEXELS)}, rowY)).rgb);
      float strength = boost * boostShare * clamp(0.5 + (thinness - 0.5) * boostContrast, 0.0, 1.0);
      float luminance = dot(light, LUMINANCE);
      float colorLuminance = dot(boostColor, LUMINANCE);
      if (luminance > 0.0 && colorLuminance > 0.0) {
        float scale = min(luminance / colorLuminance, 1.0 / maxOf(boostColor));
        light += (boostColor * scale - light) * strength;
      }
    }
  }
  alpha = floor(alpha * 255.0 + 0.5) / 255.0;
  if (alpha <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Mixed with the sky in linear light, as the browser will show it over the
  // sky layer (colorOver() in skyImage.js), with premultiplied color
  vec3 behindScreen = skyTexel.rgb;
  vec3 behind = decodeSrgb((behindScreen - BLACK_LEVEL) / (1.0 - BLACK_LEVEL));
  vec3 target = toScreen(behind + (light - behind) * alpha);
  gl_FragColor = vec4(clamp(target - behindScreen * (1.0 - alpha), 0.0, alpha), alpha);
}
`;

// Shows two frames blended (premultiplied colors blend straight from old to new)
const BLEND_SHADER = `
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 size;
void main() {
  vec2 position = gl_FragCoord.xy / size;
  gl_FragColor = mix(texture2D(from, position), texture2D(to, position), progress);
}
`;

/**
 * Sets up WebGL cloud drawing on `canvas`. Returns null if the device can't
 * (no WebGL, or no high-precision floats in fragment shaders), so the caller
 * can draw the clouds another way.
 */
export function createCloudRenderer(canvas) {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;
  const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (!highp || highp.precision < 23) return null;

  const cloudProgram = createProgram(gl, CLOUD_SHADER);
  const blendProgram = createProgram(gl, BLEND_SHADER);
  if (!cloudProgram || !blendProgram) return null;

  // A triangle covering the whole canvas
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const permutation = createTexture(gl, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 512, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, permutationImage());
  const rows = createTexture(gl, gl.NEAREST);
  const scatteringLut = createTexture(gl, gl.LINEAR);
  // Frames: `from` and `to` are faded between; `spare` takes the blend shown
  // when a new frame starts, so the next fade starts exactly from it
  const frames = { from: createFrame(gl), to: createFrame(gl), spare: createFrame(gl) };

  let width = 0;
  let height = 0;
  let shaderData = null;
  let fade = { start: 0, duration: 1 };
  let hasFrame = false;

  function drawWith(program, target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(program.attribute);
    gl.vertexAttribPointer(program.attribute, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function bindTexture(unit, texture, program, name) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.useProgram(program.program);
    gl.uniform1i(program.uniform(name), unit);
  }

  // Draws `from` and `to` blended into `target` (the canvas if null).
  // `fromFrame` replaces `from`, so a frame can be copied into `from`.
  function drawBlend(progress, target, fromFrame = frames.from) {
    const { uniform } = blendProgram;
    bindTexture(0, fromFrame.texture, blendProgram, 'from');
    bindTexture(1, frames.to.texture, blendProgram, 'to');
    gl.uniform1f(uniform('progress'), progress);
    gl.uniform2f(uniform('size'), width, height);
    drawWith(blendProgram, target);
  }

  // Draws the clouds at `time` (seconds) into `target`
  function drawClouds(time, settings, target) {
    const { uniform } = cloudProgram;
    const { uniforms, layers } = shaderData;
    bindTexture(0, permutation, cloudProgram, 'permutation');
    bindTexture(1, rows, cloudProgram, 'rows');
    bindTexture(2, scatteringLut, cloudProgram, 'scatteringLut');
    gl.uniform1f(uniform('height'), height);
    gl.uniform1f(uniform('cloudMaxOpacity'), uniforms.cloudMaxOpacity);
    gl.uniform1f(uniform('scattering'), uniforms.scattering ? 1 : 0);
    gl.uniform1f(uniform('glowWidth'), uniforms.glowWidth);
    gl.uniform1f(uniform('rimDepth'), uniforms.rimDepth);
    gl.uniform1f(uniform('thickness'), uniforms.thickness);
    gl.uniform1f(uniform('depthNeeded'), uniforms.depthNeeded);
    gl.uniform1f(uniform('boost'), uniforms.boost);
    gl.uniform1f(uniform('boostContrast'), uniforms.boostContrast);
    const origins = cloudNoiseOrigins({ ...settings, time });
    const band = new Float32Array(MAX_LAYERS * 4);
    const noise = new Float32Array(MAX_LAYERS * 4);
    const origin = new Float32Array(MAX_LAYERS * 4);
    layers.slice(0, MAX_LAYERS).forEach((layer, i) => {
      band.set([layer.bottom, layer.top, layer.cover, layer.threshold], i * 4);
      noise.set([layer.frequency[0], layer.frequency[1], layer.boostShare, 1], i * 4);
      origin.set(origins[i], i * 4);
    });
    gl.uniform4fv(uniform('layerBand[0]'), band);
    gl.uniform4fv(uniform('layerNoise[0]'), noise);
    gl.uniform4fv(uniform('layerOrigin[0]'), origin);
    drawWith(cloudProgram, target);
  }

  return {
    /**
     * Sets the canvas size (pixels) and the scene, as `data` from
     * cloudShaderData for that height. Call before drawing a frame whenever
     * either changes.
     */
    setScene(data, newWidth, newHeight) {
      if (newWidth !== width || newHeight !== height) {
        width = newWidth;
        height = newHeight;
        canvas.width = width;
        canvas.height = height;
        for (const frame of Object.values(frames)) resizeFrame(gl, frame, width, height);
        hasFrame = false;
      }
      shaderData = data;
      gl.bindTexture(gl.TEXTURE_2D, rows);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ROW_TEXELS, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, shaderData.rows);
      gl.bindTexture(gl.TEXTURE_2D, scatteringLut);
      const lut = shaderData.scatteringLut ?? new Uint8Array(4);
      const lutWidth = shaderData.scatteringLut ? SCATTERING_LUT_SIZE : 1;
      const lutHeight = shaderData.scatteringLut ? height : 1;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lutWidth, lutHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    },

    /**
     * Draws the clouds at `time` (seconds, from settings as given to
     * setScene) as a new frame, fading in from what's shown over `duration` ms
     */
    drawFrame(settings, time, duration) {
      // What's shown now becomes where the fade starts
      if (hasFrame) {
        drawBlend(fadeProgress(fade, performance.now()), frames.spare);
        [frames.from, frames.spare] = [frames.spare, frames.from];
      }
      drawClouds(time, settings, frames.to);
      if (!hasFrame) {
        // The first frame is copied into `from` (reading only `to`, since a
        // texture can't be read while it's being drawn into)
        drawBlend(1, frames.from, frames.to);
        hasFrame = true;
      }
      fade = { start: performance.now(), duration };
    },

    // Shows the fade as of `now`; returns whether it's still going
    paint(now) {
      if (!hasFrame) return false;
      const progress = fadeProgress(fade, now);
      drawBlend(progress, null);
      return progress < 1;
    },

    /**
     * Times drawing one cloud frame on the GPU (median ms over `runs`), by
     * waiting for each to finish. Uses the scene from setScene.
     */
    measureFrame(settings, runs = 5) {
      const pixel = new Uint8Array(4);
      const times = [];
      for (let run = 0; run <= runs; run++) {
        const start = performance.now();
        drawClouds(settings.time + run, settings, frames.spare);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        if (run > 0) times.push(performance.now() - start);
      }
      return times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
    },

    // Frees the GPU memory this renderer holds; it can't be used after
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

function fadeProgress(fade, now) {
  return Math.min(1, Math.max(0, (now - fade.start) / fade.duration));
}

function createProgram(gl, fragmentSource) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Cloud shader failed to compile:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Cloud shader failed to link:', gl.getProgramInfoLog(program));
    return null;
  }
  const locations = new Map();
  return {
    program,
    attribute: gl.getAttribLocation(program, 'position'),
    uniform(name) {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
      return locations.get(name);
    },
  };
}

function createTexture(gl, filter) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

// A texture that can be drawn into
function createFrame(gl) {
  const texture = createTexture(gl, gl.NEAREST);
  const framebuffer = gl.createFramebuffer();
  return { texture, framebuffer };
}

function resizeFrame(gl, frame, width, height) {
  gl.bindTexture(gl.TEXTURE_2D, frame.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, frame.framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, frame.texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
