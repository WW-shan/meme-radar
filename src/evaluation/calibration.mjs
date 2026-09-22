import { evaluateClassification } from './metrics.mjs';

export const CALIBRATION_VERSION = 'calibration-v1';
export const CALIBRATION_MINIMUM_SAMPLE = 500;
export const CALIBRATION_MAXIMUM_ECE = .10;
export const OBSERVATION_MINIMUM_SAMPLE = 50;

export function calibrationReport(rows, options = {}) {
  const settings = typeof options === 'number' ? { bins: options } : options;
  const bins = Number.isInteger(settings.bins) && settings.bins > 0 ? settings.bins : 10;
  const modelVersion = settings.modelVersion === undefined ? 'radar-v3' : settings.modelVersion;
  const metrics = evaluateClassification(rows, { threshold: .5, bins });
  const expectedCalibrationError = metrics.expectedCalibrationError;
  const balanced = metrics.positiveCount > 0 && metrics.negativeCount > 0;
  const metadataComplete = typeof modelVersion === 'string' && modelVersion.trim().length > 0;
  const ready = metadataComplete
    && balanced
    && metrics.sampleCount >= CALIBRATION_MINIMUM_SAMPLE
    && expectedCalibrationError !== null
    && expectedCalibrationError <= CALIBRATION_MAXIMUM_ECE;
  const canStartObservation = metrics.sampleCount >= OBSERVATION_MINIMUM_SAMPLE;
  return {
    version: CALIBRATION_VERSION,
    ready,
    status: ready ? 'CALIBRATED' : canStartObservation ? 'OBSERVING' : 'INSUFFICIENT',
    minimumSample: CALIBRATION_MINIMUM_SAMPLE,
    observationMinimum: OBSERVATION_MINIMUM_SAMPLE,
    canStartObservation,
    sampleCount: metrics.sampleCount,
    totalCount: metrics.totalCount,
    positiveCount: metrics.positiveCount,
    negativeCount: metrics.negativeCount,
    missingLabels: metrics.missingLabels,
    missingScores: metrics.missingScores,
    invalidScores: metrics.invalidScores,
    expectedCalibrationError,
    maximumCalibrationError: metrics.maximumCalibrationError,
    brierScore: metrics.brierScore,
    dataCutoff: settings.dataCutoff ?? null,
    modelVersion,
    lastCalibratedAt: settings.lastCalibratedAt ?? null,
    bins: metrics.calibrationBins
  };
}
