// Spectral data for sky color calculations, every 10 nm from 380 to 780 nm.
//
// The solar irradiance and ozone tables come from Eric Bruneton's Precomputed
// Atmospheric Scattering (https://github.com/ebruneton/precomputed_atmospheric_scattering,
// Copyright (c) 2017 Eric Bruneton, BSD 3-Clause License). Each value there is
// the original data averaged over the 10 nm starting at that wavelength.
// - Solar irradiance: ASTM G-173 spectrum above the atmosphere, in W/m² per nm
// - Ozone absorption cross section: IUP Bremen reference spectra at 233 K, in m²
// The color matching functions are the CIE 1931 2° standard observer.

export const WAVELENGTHS = Array.from({ length: 41 }, (_, i) => 380 + 10 * i); // nm

export const SOLAR_IRRADIANCE = [
  1.01249, 1.14716, 1.72765, 1.73054, 1.6887, 1.61253, 1.91198, 2.03474, 2.02042,
  2.02212, 1.93377, 1.95809, 1.91686, 1.8298, 1.8685, 1.8931, 1.85149, 1.8504,
  1.8341, 1.8345, 1.8147, 1.78158, 1.7533, 1.6965, 1.68194, 1.64654, 1.6048,
  1.52143, 1.55622, 1.5113, 1.474, 1.4482, 1.41018, 1.36775, 1.34188, 1.31429,
  1.28303, 1.26758, 1.2367, 1.2082, 1.18737,
];

export const OZONE_CROSS_SECTION = [
  2.818e-28, 6.636e-28, 1.527e-27, 2.763e-27, 5.52e-27, 8.451e-27, 1.582e-26,
  2.316e-26, 3.669e-26, 4.924e-26, 7.752e-26, 9.016e-26, 1.48e-25, 1.602e-25,
  2.139e-25, 2.755e-25, 3.091e-25, 3.5e-25, 4.266e-25, 4.672e-25, 4.398e-25,
  4.701e-25, 5.019e-25, 4.305e-25, 3.74e-25, 3.215e-25, 2.662e-25, 2.238e-25,
  1.852e-25, 1.473e-25, 1.209e-25, 9.423e-26, 7.455e-26, 6.566e-26, 5.105e-26,
  4.15e-26, 4.228e-26, 3.237e-26, 2.451e-26, 2.801e-26, 2.534e-26,
];

const CIE_X = [
  0.001368, 0.004243, 0.01431, 0.04351, 0.13438, 0.2839, 0.34828, 0.3362, 0.2908,
  0.19536, 0.09564, 0.03201, 0.0049, 0.0093, 0.06327, 0.1655, 0.2904, 0.4334499,
  0.5945, 0.7621, 0.9163, 1.0263, 1.0622, 1.0026, 0.8544499, 0.6424, 0.4479,
  0.2835, 0.1649, 0.0874, 0.04677, 0.0227, 0.01135916, 0.005790346, 0.002899327,
  0.001439971, 0.0006900786, 0.0003323011, 0.0001661505, 0.00008307527,
  0.00004150994,
];

const CIE_Y = [
  0.000039, 0.00012, 0.000396, 0.00121, 0.004, 0.0116, 0.023, 0.038, 0.06,
  0.09098, 0.13902, 0.20802, 0.323, 0.503, 0.71, 0.862, 0.954, 0.9949501, 0.995,
  0.952, 0.87, 0.757, 0.631, 0.503, 0.381, 0.265, 0.175, 0.107, 0.061, 0.032,
  0.017, 0.00821, 0.004102, 0.002091, 0.001047, 0.00052, 0.0002492, 0.00012,
  0.00006, 0.00003, 0.00001499,
];

const CIE_Z = [
  0.006450001, 0.02005001, 0.06785001, 0.2074, 0.6456, 1.3856, 1.74706, 1.77211,
  1.6692, 1.28764, 0.8129501, 0.46518, 0.272, 0.1582, 0.07824999, 0.04216, 0.0203,
  0.008749999, 0.0039, 0.0021, 0.001650001, 0.0011, 0.0008, 0.00034, 0.00019,
  0.00004999999, 0.00002, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

// Lumens per watt of light at 555 nm, where the eye is most sensitive
const MAX_LUMINOUS_EFFICACY = 683;
const WAVELENGTH_STEP = 10; // nm

/**
 * Converts spectral radiance (W/m²/sr per nm, at each of WAVELENGTHS) to CIE
 * XYZ, scaled so that Y is luminance in cd/m².
 */
export function spectrumToXYZ(radiance) {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let i = 0; i < WAVELENGTHS.length; i++) {
    X += radiance[i] * CIE_X[i];
    Y += radiance[i] * CIE_Y[i];
    Z += radiance[i] * CIE_Z[i];
  }
  const scale = MAX_LUMINOUS_EFFICACY * WAVELENGTH_STEP;
  return { X: X * scale, Y: Y * scale, Z: Z * scale };
}
