import { HillaireSkyModel } from './HillaireSkyModel.js';

/*
 * Methods for calculating the sky's color. Each has:
 * - createAtmosphere(conditions), building its lookup tables for the weather
 *   in `conditions`, as plain data that can be sent between threads
 * - calculateSkyXYZ(atmosphere, conditions, views), where each view is
 *   { elevation, azimuthFromSun } in degrees, returning the CIE XYZ color of
 *   the sky in each view direction, with Y being luminance in cd/m²
 * - calculateSunlightXYZ(atmosphere, conditions, heights), with heights in
 *   km, returning the CIE XYZ color of direct sunlight at each height, with Y
 *   being illuminance in lux (0 where Earth blocks the sun)
 * To add a method, implement those and add it here.
 */
export const SKY_MODELS = {
  hillaire2020: HillaireSkyModel,
};

// The method used for calculations
export const SELECTED_SKY_MODEL = 'hillaire2020';
