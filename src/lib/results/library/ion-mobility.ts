// The precursor's ion mobility in the spectral library: OpenNuXL writes a timsTOF precursor's collision cross section
// (the hit's 'IM' UserParam, Å²); DIA-NN wants the reduced mobility 1/K0 (V·s/cm²). The Mason–Schamp equation in N2 at
// 305 K, with the constants and the formula of nuxl2dia.py (which match its R original).
//
// Ported from nuxl-app src/nuxl2dia.py (NuXL Team; NuXLDIA, github.com/timosachsenberg/NuXLDIA: `_ccs_to_im`), BSD-3,
// Copyright OpenMS Inc. -- Eberhard Karls University Tuebingen, ETH Zurich, and Freie Universitaet Berlin
// 2002-present.

const BOLTZMANN = 1.38064852e-23 // J/K
const ELEMENTARY_CHARGE = 1.6021766208e-19 // C
const AMU_TO_KG = 1.66053904e-27 // kg/Da
const LOSCHMIDT = 2.6867811e25 // molecules/m³ at STP
/** The drift gas, N2 (Da), and its temperature (K): timsTOF's, as nuxl2dia.py has them. */
const DRIFT_GAS_MASS = 28.0134
const TEMPERATURE = 305

/**
 * The reduced ion mobility 1/K0 (V·s/cm²) of a precursor of collision cross section `ccs` (Å²), charge `charge` and
 * m/z `mz`; NaN when one is unknown (NaN), the CCS or the m/z is not above 0 (OpenNuXL writes IM 0 for a spectrum
 * whose 1/K0 it could not convert) or the charge is 0.
 */
export function ccsToInverseK0(ccs: number, charge: number, mz: number): number {
  if (!(ccs > 0) || !(mz > 0) || Number.isNaN(charge) || charge === 0) return NaN
  const ionMass = mz * charge
  const reducedMass = ((ionMass * DRIFT_GAS_MASS) / (ionMass + DRIFT_GAS_MASS)) * AMU_TO_KG
  const temperatureFactor = Math.sqrt((2 * Math.PI) / (reducedMass * BOLTZMANN * TEMPERATURE))
  return (ccs * LOSCHMIDT) / (charge * (3 / 16) * 1e4 * 1e20 * temperatureFactor * ELEMENTARY_CHARGE)
}
