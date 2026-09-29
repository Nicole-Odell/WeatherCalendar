/**
 * Converts hue (degrees), saturation (0–1) and value (0–1) to linear-light
 * sRGB [red, green, blue], each 0–1. The sky colors from the server use this
 * linear-light form.
 */
export function hsvToLinearRgb(hue, saturation, value) {
  const channel = (n) => {
    const k = (n + hue / 60) % 6;
    return value * (1 - saturation * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [channel(5), channel(3), channel(1)];
}

/**
 * Dims a linear-light sRGB color to a screen brightness from 0 (black) to 1
 * (unchanged). Brightness is as it looks on screen, like HSB brightness,
 * rather than the amount of light.
 */
export function withScreenBrightness(rgb, brightness) {
  return rgb.map((linear) => decodeSrgb(brightness * encodeSrgb(linear)));
}

// Converts linear-light sRGB [red, green, blue] to a CSS color
export function linearRgbToCss(rgb) {
  const [red, green, blue] = rgb.map((linear) => Math.round(255 * encodeSrgb(linear)));
  return `rgb(${red} ${green} ${blue})`;
}

/**
 * Returns black or white, whichever is easier to read over a background color
 * given in linear-light sRGB. Below a luminance of about 0.18, white text has
 * more contrast than black.
 */
export function readableTextColor([red, green, blue]) {
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.179 ? 'black' : 'white';
}

// Applies the sRGB curve that screens expect
function encodeSrgb(linear) {
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
}

// Undoes the sRGB curve
function decodeSrgb(encoded) {
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}
