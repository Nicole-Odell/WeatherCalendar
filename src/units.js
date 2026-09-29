// Open-Meteo's default (metric) units and how to show them in US units
const IMPERIAL_CONVERSIONS = {
  '°C': { unit: '°F', decimals: 1, convert: (c) => (c * 9) / 5 + 32 },
  mm: { unit: 'in', decimals: 2, convert: (mm) => mm / 25.4 },
  cm: { unit: 'in', decimals: 1, convert: (cm) => cm / 2.54 },
  'km/h': { unit: 'mph', decimals: 1, convert: (kmh) => kmh / 1.609344 },
  hPa: { unit: 'inHg', decimals: 2, convert: (hpa) => hpa / 33.8639 },
};

/**
 * Converts a value in one of Open-Meteo's metric units to US units, rounded
 * for display. Units that are the same in both systems (%, °, etc.) and
 * missing values are returned unchanged.
 */
export function toImperial(value, unit) {
  const conversion = IMPERIAL_CONVERSIONS[unit];
  if (!conversion || typeof value !== 'number') {
    return { value, unit };
  }
  const factor = 10 ** conversion.decimals;
  return {
    value: Math.round(conversion.convert(value) * factor) / factor,
    unit: conversion.unit,
  };
}
