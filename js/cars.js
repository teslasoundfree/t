/*
 * Car profiles. Each profile has an `engine` block (consumed by both the
 * synthesizer in engine-dsp.js and the drivetrain simulation in vehicle.js)
 * and a `vehicle` block (drivetrain + physics for the simulation).
 *
 * To add a car, append another object with the same shape.
 *
 * `pro: true` marks a car that is only in TeslaSound Pro; the others are free.
 * `soon: true` marks a car whose sound isn't made yet: it has no `engine` or
 * `vehicle` block, shows in "Show all cars" and can be pinned, but can't be driven.
 */
window.MOTORSOUND_CARS = [
  {
    id: 'tesla-roadster-thrust',
    name: 'Tesla Roadster',
    tagline: 'Four cold-gas thrusters · 80+ kN · two rear motors, 1 MW',
    // Where the thrusters' jets leave the picture (thruster-fx.js): the
    // black tail panel, as fractions of the picture; h is the jet's
    // thickness there, and they blow to the left (dir -1: the car faces
    // right, like the others).
    nozzle: { x: 0.0721, y: 0.64, h: 0.12, dir: -1 },
    // Picked: its button blows out a cloud of smoke and the car backflips
    // on its thrusters (thruster-fx.js).
    selectFx: 'thrusterFlip',
    engine: {
      // No engine: ThrusterDSP, air jets fired by the pedal (REV at a
      // standstill), silent otherwise. The drivetrain below runs as an
      // engine's in vehicle.js, for the tach and how the car pulls: one gear,
      // and the tach is the rear motors' rpm.
      type: 'thruster',
      // Motors stand still at rest, but vehicle.js wobbles the idle by up to
      // 28 rpm, and 0 would show negative rpm on the tach.
      idleRpm: 30,
      redlineRpm: 20600,
      limiterRpm: 21000,
      softLimiter: true,
      launchRpm: 0,
      // Not published: effective torque at the motor shafts, so the test
      // drive pulls about 1.2 g to well past 130 km/h.
      peakTorqueNm: 2600,
      peakTorqueRpm: 0,
      // Regen when lifting off: about 1.5 m/s² at 100 km/h.
      engineBrakeNm: 480,
      sound: {
        // Four nozzles across the tail, left to right, each a little
        // different (tune scales its pitch).
        jets: [
          { pan: -0.6, tune: 0.95 },
          { pan: -0.2, tune: 1.04 },
          { pan: 0.2, tune: 1 },
          { pan: 0.6, tune: 1.08 }
        ],
        // Mixing-noise roar, centred here from a light to a full blast:
        // more pressure swells the jet and deepens it.
        roarHz: [900, 380],
        roarQ: 0.55,
        // Shock-cell hiss (broadband shock-associated noise), strongest
        // towards the cabin. Kept low and below 3 kHz, where it was
        // piercing.
        shockHz: [2600, 1700],
        shockQ: 1.3,
        shock: 0.18,
        // Low rumble through the body.
        rumbleHz: 110,
        rumble: 3,
        // Turbulence: each jet wanders on its own (flutter), the row
        // together (surge), at random.
        flutter: 0.2,
        surge: 0.25,
        // Only a brisk foot fires the jets: below this much pedal they stay
        // shut, so normal driving is silent. On the road (Intensity 0.5) they
        // start at about 0.2 g of real acceleration (30 to 60 km/h in 4 s
        // gives a hint), smoke clearly at 0.28 g (30 to 60 in 3 s), and the
        // full blast is about 0.55 g.
        onset: 0.3,
        // Level = (pedal past the onset) ^ curve: just past it a thin hiss,
        // floored the whole blast, and lifting off dies away fast.
        curve: 1.5,
        // Valves: open, shut, and the lines venting after them.
        attackMs: 35,
        releaseMs: 45,
        ventMs: 150,
        // Cracks per second at full thrust and Crackle 1, and how loud.
        crackle: 120,
        crackGain: 0.2,
        // A soft low whump when the valves open hard from rest.
        thump: 0.5,
        // Cabin low-pass, from Character 0 to 1: dark, so the blast is a
        // roar and not a hiss that hurts the ears.
        cabinHz: [2200, 3800],
        // A barely there hiss with the valves shut (about as quiet as
        // ElectricZen standing still), so it is never digital silence.
        floor: 0.0017,
        drive: 1.3,
        gain: 0.5
      }
    },
    vehicle: {
      massKg: 1800,
      cdA: 0.6,
      crr: 0.011,
      maxAccel: 12,
      peakPowerKw: 1000,
      drivetrainEff: 0.9,
      ratios: [7.5],
      finalDrive: 1,
      tireCircumferenceM: 2.25,
      maxSpeedKmh: 370
    }
  },
  {
    id: 'city-shifter',
    name: 'Shift Maniac',
    tagline: 'Flat-six scream · 9,000 rpm · 10 short gears · tops out at 120 km/h',
    engine: {
      idleRpm: 850,
      redlineRpm: 9000,
      limiterRpm: 9000,
      // Never above the 9 mark: shift up early enough that the revs stay under it,
      // and hard-cap free revving at the limiter, where it bounces just under 9,000.
      // Gentle driving shifts up around 6,500 rpm, which puts the hand-overs on the
      // speed map in the gearing below. Full throttle holds each gear up to 8,000 rpm for the wow.
      cruiseUpshiftRpm: 6300,
      upshiftRpm: 8000,
      hardCap: true,
      launchRpm: 4200,
      peakTorqueNm: 470,
      peakTorqueRpm: 6100,
      engineBrakeNm: 60,
      // Same flat-six as the GT3: 1-6-2-4-3-5, every 120°, banks alternate.
      firing: [
        [0, 1, 0], [120, 6, 1], [240, 2, 0], [360, 4, 1], [480, 3, 0], [600, 5, 1]
      ],
      sound: {
        banks: [
          { pipeMs: 4.6, pan: -0.4, tune: 1 },
          { pipeMs: 4.8, pan: 0.4, tune: 1.03 }
        ],
        pipeReflection: -0.45,
        pipeDamping: 0.3,
        formants: [
          { hz: 150, q: 1.0, gain: 0.8 },
          { hz: 620, q: 2.2, gain: 0.6 },
          { hz: 1900, q: 2.5, gain: 0.45 }
        ],
        formantDry: 0.4,
        pulseMsIdle: 3.0,
        pulseMsRedline: 0.7,
        noise: 0.5,
        jitter: 0.025,
        cylinderTrim: 0.03,
        lope: 0.06,
        mufflerHz: [1100, 7000],
        bodyHz: 110,
        bodyDb: 2,
        intake: 0.16,
        intakeHz: 900,
        whine: 0.05,
        whineRatio: 4.5,
        crackle: 0.9,
        popGain: 0.5,
        drive: 3.2,
        gain: 0.58
      }
    },
    vehicle: {
      massKg: 1435,
      cdA: 0.68,
      crr: 0.011,
      maxAccel: 8.0,
      peakPowerKw: 375,
      drivetrainEff: 0.9,
      // Gearing built from a speed map: each gear is the one to be in up to
      // 12 / 30 / 35 / 40 / 50 / 55 / 60 / 70 / 80 km/h, and 10th takes over
      // above 80. Each hand-over lands near 6,500 rpm; 10th is 8,400 rpm at the
      // 120 km/h cap.
      ratios: [8.94, 3.58, 3.06, 2.68, 2.15, 1.95, 1.79, 1.53, 1.34, 1.16],
      maxSpeedKmh: 120,
      finalDrive: 8.0,
      tireCircumferenceM: 2.2
    }
  },
  {
    id: 'gt3',
    name: 'Porsche 911 GT3',
    tagline: '4.0 L flat-six · 9,000 rpm · 7-speed PDK',
    engine: {
      idleRpm: 850,
      redlineRpm: 9000,
      limiterRpm: 9200,
      launchRpm: 3800,
      peakTorqueNm: 470,
      peakTorqueRpm: 6100,
      engineBrakeNm: 55,
      // Flat-six firing order 1-6-2-4-3-5, evenly spaced every 120°.
      // Cylinders 1-3 on one bank, 4-6 on the other, so the banks alternate.
      firing: [
        [0, 1, 0], [120, 6, 1], [240, 2, 0], [360, 4, 1], [480, 3, 0], [600, 5, 1]
      ],
      sound: {
        banks: [
          { pipeMs: 4.6, pan: -0.4, tune: 1 },
          { pipeMs: 4.8, pan: 0.4, tune: 1.03 }
        ],
        pipeReflection: -0.45,
        pipeDamping: 0.3,
        formants: [
          { hz: 150, q: 1.0, gain: 0.8 },
          { hz: 620, q: 2.2, gain: 0.6 },
          { hz: 1900, q: 2.5, gain: 0.4 }
        ],
        formantDry: 0.4,
        pulseMsIdle: 3.0,
        pulseMsRedline: 0.7,
        noise: 0.5,
        jitter: 0.025,
        cylinderTrim: 0.03,
        lope: 0.06,
        mufflerHz: [1100, 7000],
        bodyHz: 110,
        bodyDb: 2,
        intake: 0.14,
        intakeHz: 900,
        whine: 0.05,
        whineRatio: 4.5,
        crackle: 0.6,
        popGain: 0.45,
        drive: 3.2,
        gain: 0.58
      }
    },
    vehicle: {
      massKg: 1435,
      cdA: 0.68,
      crr: 0.011,
      maxAccel: 8.0,
      peakPowerKw: 375,
      drivetrainEff: 0.9,
      ratios: [3.75, 2.38, 1.72, 1.34, 1.08, 0.88, 0.72],
      finalDrive: 3.9,
      tireCircumferenceM: 2.2
    }
  },
  {
    id: 'v8-muscle',
    name: 'V8 Muscle',
    tagline: '6.2 L crossplane V8 · 6-speed · dual exhaust',
    engine: {
      idleRpm: 760,
      redlineRpm: 6500,
      limiterRpm: 6600,
      launchRpm: 2600,
      peakTorqueNm: 630,
      peakTorqueRpm: 4600,
      engineBrakeNm: 70,
      // [crank angle °, cylinder, bank]. GM small-block firing order
      // 1-8-7-2-6-5-4-3, odd cylinders on bank 0 and even on bank 1. Each bank
      // fires unevenly (180-270-180-90°), which is where the burble comes from.
      firing: [
        [0, 1, 0], [90, 8, 1], [180, 7, 0], [270, 2, 1],
        [360, 6, 1], [450, 5, 0], [540, 4, 1], [630, 3, 0]
      ],
      sound: {
        banks: [
          { pipeMs: 6.8, pan: -0.55, tune: 1 },
          { pipeMs: 7.9, pan: 0.55, tune: 1.06 }
        ],
        pipeReflection: -0.5,
        pipeDamping: 0.35,
        formants: [
          { hz: 110, q: 1.0, gain: 1.1 },
          { hz: 380, q: 2.0, gain: 0.6 },
          { hz: 1150, q: 2.5, gain: 0.25 }
        ],
        formantDry: 0.35,
        pulseMsIdle: 3.6,
        pulseMsRedline: 1.0,
        noise: 0.45,
        jitter: 0.05,
        cylinderTrim: 0.06,
        lope: 0.22,
        mufflerHz: [700, 4800],
        bodyHz: 85,
        bodyDb: 4,
        intake: 0.05,
        intakeHz: 520,
        whine: 0,
        whineRatio: 6.5,
        crackle: 1,
        popGain: 0.5,
        drive: 3,
        gain: 0.6
      }
    },
    vehicle: {
      massKg: 1750,
      cdA: 0.72,
      crr: 0.012,
      maxAccel: 6.5,
      peakPowerKw: 340,
      drivetrainEff: 0.88,
      ratios: [2.66, 1.78, 1.30, 1.00, 0.74, 0.50],
      finalDrive: 3.73,
      tireCircumferenceM: 2.15
    }
  },
  {
    id: 'ferrari-v12',
    name: 'Ferrari V12',
    tagline: '6.5 L V12 · 8,900 rpm · 7-speed dual-clutch',
    engine: {
      idleRpm: 900,
      redlineRpm: 8900,
      limiterRpm: 9000,
      // Where the tach's red zone starts (gauge only; defaults to redlineRpm).
      tachRedRpm: 8000,
      launchRpm: 3500,
      peakTorqueNm: 718,
      peakTorqueRpm: 7000,
      engineBrakeNm: 60,
      // V12 firing order 1-7-5-11-3-9-6-12-2-8-4-10, evenly spaced every 60°.
      // Cylinders 1-6 on one bank, 7-12 on the other, so the banks alternate.
      firing: [
        [0, 1, 0], [60, 7, 1], [120, 5, 0], [180, 11, 1], [240, 3, 0], [300, 9, 1],
        [360, 6, 0], [420, 12, 1], [480, 2, 0], [540, 8, 1], [600, 4, 0], [660, 10, 1]
      ],
      sound: {
        banks: [
          { pipeMs: 4.2, pan: -0.45, tune: 1 },
          { pipeMs: 4.3, pan: 0.45, tune: 1.02 }
        ],
        pipeReflection: -0.4,
        pipeDamping: 0.25,
        formants: [
          { hz: 130, q: 1.0, gain: 0.7 },
          { hz: 700, q: 2.4, gain: 0.55 },
          { hz: 2300, q: 2.8, gain: 0.5 }
        ],
        formantDry: 0.4,
        pulseMsIdle: 2.4,
        pulseMsRedline: 0.55,
        noise: 0.4,
        jitter: 0.015,
        cylinderTrim: 0.02,
        lope: 0.03,
        mufflerHz: [1300, 8500],
        bodyHz: 100,
        bodyDb: 2,
        intake: 0.1,
        intakeHz: 1100,
        whine: 0.03,
        whineRatio: 5,
        crackle: 0.7,
        popGain: 0.5,
        drive: 2.8,
        gain: 0.55
      }
    },
    vehicle: {
      massKg: 1600,
      cdA: 0.7,
      crr: 0.011,
      maxAccel: 8.5,
      peakPowerKw: 580,
      drivetrainEff: 0.9,
      ratios: [3.08, 2.18, 1.6, 1.25, 1.0, 0.8, 0.66],
      finalDrive: 4.0,
      tireCircumferenceM: 2.2
    }
  },
  {
    id: 'hellcat',
    name: 'Dodge Hellcat',
    tagline: '6.2 L supercharged V8 · 6,200 rpm · 6-speed manual',
    engine: {
      idleRpm: 750,
      redlineRpm: 6200,
      limiterRpm: 6400,
      // Hand-shifted: the driver changes up just short of the redline.
      upshiftRpm: 5900,
      // No bursts: no afterfire pops (crackle 0) and no ignition cut on
      // upshifts (manual gearbox). The rev limiter still bounces, like the
      // other cars, just without pops.
      launchRpm: 2500,
      peakTorqueNm: 881,
      peakTorqueRpm: 4800,
      engineBrakeNm: 75,
      // HEMI firing order 1-8-4-3-6-5-7-2, odd cylinders on bank 0 and even on
      // bank 1. Cross-plane, so each bank fires unevenly (270-180-90-180°).
      firing: [
        [0, 1, 0], [90, 8, 1], [180, 4, 1], [270, 3, 0],
        [360, 6, 1], [450, 5, 0], [540, 7, 0], [630, 2, 1]
      ],
      sound: {
        // Tuned against a reference shift recording: short pipes put the
        // exhaust resonance on the firing note (~180 Hz at 2,700 rpm), a deep
        // body resonance adds the rumble and the 0.7–1.5 kHz formants the rasp.
        banks: [
          { pipeMs: 2.8, pan: -0.55, tune: 1 },
          { pipeMs: 2.5, pan: 0.55, tune: 1.1 }
        ],
        pipeReflection: -0.55,
        pipeDamping: 0.3,
        formants: [
          { hz: 48, q: 1.2, gain: 1.0 },
          { hz: 180, q: 0.9, gain: 1.0 },
          { hz: 700, q: 1.4, gain: 1.9 },
          { hz: 1450, q: 1.6, gain: 2.4 },
          { hz: 2700, q: 2.2, gain: 0.3 },
          { hz: 4500, q: 2.0, gain: 0.2 }
        ],
        formantDry: 0.38,
        pulseMsIdle: 5.5,
        pulseMsRedline: 0.5,
        noise: 0.8,
        jitter: 0.03,
        cylinderTrim: 0.08,
        lope: 0.08,
        mufflerHz: [1400, 8000],
        bodyHz: 55,
        bodyDb: 9,
        intake: 0.08,
        intakeHz: 640,
        // Supercharger whine: a bright harmonic series, the 2nd harmonic as
        // strong as the 1st (as in reference recordings), with pitch and level
        // tuned by ear: 21.3 × crank speed (2,130 Hz at 6,000 rpm).
        whine: 0.089,
        whineRatio: 21.3,
        // Belt-driven supercharger: skips the muffler and whines only under
        // boost, coming in between 20 % and 70 % throttle, so not at idle,
        // cruising or coasting. Three voices a fraction of a percent apart
        // beat unevenly, a few times a second.
        blower: {
          boostLoad: [0.2, 0.7],
          harmonics: [1, 0.87, 0.44, 0.32, 0.28],
          voices: [[1, 1], [1.0022, 0.85], [0.9963, 0.6]]
        },
        crackle: 0,
        popGain: 0,
        // Rough, unpitched sound while the clutch is down between gears.
        burble: 1.4,
        // Gear lever: one click as each gear goes in.
        shiftClick: 0.55,
        drive: 3.6,
        gain: 0.6
      }
    },
    vehicle: {
      gearbox: 'manual',
      massKg: 2020,
      cdA: 0.85,
      crr: 0.012,
      maxAccel: 6.8,
      peakPowerKw: 527,
      drivetrainEff: 0.85,
      ratios: [2.97, 2.10, 1.46, 1.00, 0.74, 0.50],
      finalDrive: 3.70,
      tireCircumferenceM: 2.29
    }
  },
  {
    id: 'haunted-hearse',
    name: 'Haunted Hearse',
    tagline: 'No engine · heartbeat at a stop · ghost choir · church bell',
    engine: {
      // No engine sound, only Halloween sounds (HauntedDSP in engine-dsp.js).
      // The drive is still simulated as an old 7-litre V8 with a 3-speed
      // automatic, for the tach and how the car pulls.
      type: 'haunted',
      idleRpm: 600,
      redlineRpm: 5200,
      limiterRpm: 5400,
      launchRpm: 1800,
      peakTorqueNm: 610,
      peakTorqueRpm: 2800,
      engineBrakeNm: 60,
      sound: {
        // Each sound's level at full strength. rootHz is the note of the
        // choir's chord, the moan and the bell (D).
        heart: 0.6,
        heartBpm: [56, 130],   // resting, and with the accelerator or REV pressed
        wind: 0.25,
        choir: 0.3,
        rootHz: 146.83,
        moan: 0.25,
        bell: 0.2,
        growl: 0.45,
        scream: 0.35,          // one shriek for each press of REV
        reverb: 0.5
      }
    },
    vehicle: {
      massKg: 2600,
      cdA: 0.95,
      crr: 0.013,
      maxAccel: 4.5,
      peakPowerKw: 260,
      drivetrainEff: 0.85,
      ratios: [2.48, 1.48, 1.0],
      finalDrive: 3.07,
      tireCircumferenceM: 2.3
    }
  },
  {
    id: 'electric-zen',
    name: 'ElectricZen',
    tagline: 'Electric buzz · deep when slow, light when fast · near-silent regen',
    pro: true,
    engine: {
      // An electric motor: ElectricDSP instead of the combustion synthesizer,
      // and a single-speed drivetrain in vehicle.js. rpm is the motor's
      // (about 7,000 at 100 km/h).
      type: 'electric',
      idleRpm: 0,
      redlineRpm: 16000,
      limiterRpm: 16000,
      sound: {
        // The note: baseHz standing still, rising with motor rpm as
        // baseHz × (1 + rpm / kneeRpm) ^ curve: about 55 Hz at 10 km/h,
        // 140 Hz at 50, 235 Hz at 100 and 400 Hz at 200 km/h.
        baseHz: 38,
        kneeRpm: 900,
        curve: 0.85,
        beatHz: 1.4,     // second oscillator this far above the first: a slow beat
        cruise: 0,       // buzz at a steady speed (0..1 of full); 0: as quiet as standing still
        bass: 0.22,      // extra fundamental at low speed, gone by top speed
        whine: 0.025,    // motor whine two octaves up, rising in with speed
        whineRatio: 4,
        hum: 0.022,      // the near-silent hum on regen and standing still
        gain: 0.24
      }
    },
    vehicle: {
      massKg: 1850,
      cdA: 0.58,
      crr: 0.01,
      maxAccel: 6.5,
      peakPowerKw: 300,
      drivetrainEff: 0.92,
      ratios: [9.0],
      finalDrive: 1,
      tireCircumferenceM: 2.2,
      maxSpeedKmh: 225,
      regenDecel: 1.4    // m/s² when lifting off in the test drive (one-pedal driving)
    }
  },
  {
    id: 'lamborghini-urus',
    name: 'Lamborghini Urus',
    tagline: '4.0 L twin-turbo V8 · 6,800 rpm · 8-speed automatic',
    pro: true,
    engine: {
      idleRpm: 650,
      redlineRpm: 6700,
      limiterRpm: 6800,
      launchRpm: 3000,
      peakTorqueNm: 850,
      peakTorqueRpm: 3600,
      engineBrakeNm: 80,
      // Firing order 1-3-7-2-6-5-4-8, cylinders 1-4 on bank 0 and 5-8 on bank 1
      // (Audi numbering). Cross-plane crank, so each bank fires unevenly
      // (90-180-270-180°), and each bank has its own turbo and exhaust line.
      firing: [
        [0, 1, 0], [90, 3, 0], [180, 7, 1], [270, 2, 0],
        [360, 6, 1], [450, 5, 1], [540, 4, 0], [630, 8, 1]
      ],
      sound: {
        // Two separate exhaust lines, no X-cross (Akrapovic titanium), made
        // more different from each other for a rougher, uneven texture. Pipe
        // resonances at about 83 / 250 / 417 Hz and 68 / 205 / 342 Hz.
        banks: [
          { pipeMs: 6.0, pan: -0.55, tune: 1 },
          { pipeMs: 7.3, pan: 0.55, tune: 1.09 }
        ],
        pipeReflection: -0.5,
        pipeDamping: 0.32,
        // The lion: deep rumble at idle (82 Hz, on the idle's strongest
        // harmonic), snarl at mid revs (190 Hz), roar near the top (420 Hz, the
        // firing note at about 6,300 rpm) and rasp (900 / 1,400 / 2,400 Hz),
        // which only the short pulses and noise under load reach.
        formants: [
          { hz: 82, q: 1.0, gain: 1.2 },
          { hz: 190, q: 1.1, gain: 1.0 },
          { hz: 420, q: 1.4, gain: 1.0 },
          { hz: 900, q: 1.6, gain: 0.9 },
          { hz: 1400, q: 1.8, gain: 0.6 },
          { hz: 2400, q: 2.2, gain: 0.3 }
        ],
        formantDry: 0.35,
        // Long, soft pulses at low revs and light throttle (a dark, relaxed
        // burble when cruising), short sharp ones near the top (rasp).
        pulseMsIdle: 5.5,
        pulseMsRedline: 0.65,
        // The grit: combustion noise grows with the throttle, so it is strong
        // under load and when revving and stays low when cruising.
        noise: 1.6,
        // Uneven texture through the whole rev range: random firing strength
        // and fixed cylinder-to-cylinder differences.
        jitter: 0.07,
        cylinderTrim: 0.11,
        lope: 0.24,
        // Shut down when cruising, wide open under load.
        mufflerHz: [550, 7500],
        bodyHz: 62,
        bodyDb: 8,
        // Raspy turbo intake roar, only under load (it follows the throttle).
        intake: 0.22,
        intakeHz: 750,
        // No turbo whistle: a tone that climbs with every gear could sound like a siren.
        whine: 0,
        whineRatio: 6.5,
        crackle: 0.7,
        popGain: 0.4,
        // Lower gain with strong saturation and noise: quieter when cruising,
        // gritty and full under load.
        drive: 5,
        gain: 0.35
      }
    },
    vehicle: {
      massKg: 2230,
      cdA: 0.95,
      crr: 0.012,
      maxAccel: 8.5,
      peakPowerKw: 490,
      drivetrainEff: 0.85,
      // ZF 8HP; final drive 43:13 (from a parts listing).
      ratios: [4.71, 3.14, 2.11, 1.67, 1.28, 1.0, 0.84, 0.67],
      finalDrive: 3.31,
      // 285/40 R22 / 325/35 R22: about 787 mm across.
      tireCircumferenceM: 2.47
    }
  },
  {
    id: 'slipstream',
    name: 'F1 Slipstream',
    tagline: '1.6 L turbo V6 hybrid · 12,000 rpm · 8-speed seamless',
    pro: true,
    engine: {
      idleRpm: 4000,
      redlineRpm: 12000,
      limiterRpm: 12500,
      // Light throttle shifts up around 7,000-8,000 rpm, full throttle at 11,600,
      // where a 2026 car changes up.
      cruiseUpshiftRpm: 7000,
      upshiftRpm: 11600,
      // Drops a gear below 5,000 rpm (slowing down or cruising), so it never
      // sits at idle in a tall gear; an upshift at 7,000 lands near 5,800.
      downshiftRpm: 5000,
      // A seamless gearbox shifts at once, so the revs never run into the
      // limiter while accelerating; REV at a standstill bounces off the cut
      // just under 12,500.
      hardCap: true,
      launchRpm: 8000,
      // The combustion engine alone (about 400 kW at 10,500-11,000 rpm); the
      // MGU-K's share is in peakPowerKw.
      peakTorqueNm: 390,
      peakTorqueRpm: 10500,
      engineBrakeNm: 60,
      // 90° V6 with three shared crankpins (the rules allow no split pins):
      // firing order 1-4-3-6-2-5, alternating 90° and 150°. Cylinders 1-3 on
      // bank 0, 4-6 on bank 1; each bank fires evenly every 240°.
      firing: [
        [0, 1, 0], [90, 4, 1], [240, 3, 0], [330, 6, 1], [480, 2, 0], [570, 5, 1]
      ],
      sound: {
        // Both banks merge into one turbine and one central tailpipe: the same
        // short pipe on both (resonances at about 530 / 1,580 / 2,630 Hz, the
        // first on the firing note at about 10,500 rpm), barely panned.
        banks: [
          { pipeMs: 0.95, pan: -0.15, tune: 1 },
          { pipeMs: 0.95, pan: 0.15, tune: 1.01 }
        ],
        pipeReflection: -0.4,
        pipeDamping: 0.3,
        // Order 1.5 growl (280 Hz at 11,000 rpm), then rasp from 1.1 to 3.2 kHz.
        formants: [
          { hz: 280, q: 1.0, gain: 0.7 },
          { hz: 1100, q: 1.6, gain: 0.7 },
          { hz: 2000, q: 2.0, gain: 0.5 },
          { hz: 3200, q: 2.5, gain: 0.3 }
        ],
        formantDry: 0.4,
        // Short, sharp pulses: at 12,000 rpm the firings come 1.25 and 2.1 ms apart.
        pulseMsIdle: 1.8,
        pulseMsRedline: 0.38,
        noise: 0.8,
        jitter: 0.02,
        cylinderTrim: 0.03,
        // A slightly restless idle.
        lope: 0.08,
        // No muffler; the turbine (without an MGU-H since 2026) is the only damping.
        mufflerHz: [1600, 8500],
        bodyHz: 130,
        bodyDb: 1.5,
        // Airbox roar over the driver's head, under load.
        intake: 0.2,
        intakeHz: 1300,
        // Faint MGU-K / turbo whine, 12.7x crank speed (about 2.4 kHz at
        // 11,500 rpm), only near the top of each gear under load.
        whine: 0.0065,
        whineRatio: 12.7,
        crackle: 0.15,
        popGain: 0.2,
        drive: 2.6,
        gain: 0.45
      }
    },
    vehicle: {
      // 768 kg minimum with driver, plus some fuel.
      massKg: 800,
      cdA: 1.0,
      crr: 0.015,
      maxAccel: 9.5,
      // ICE about 400 kW plus MGU-K 350 kW.
      peakPowerKw: 750,
      drivetrainEff: 0.92,
      // Eight close ratios (about 1.2 apart), geared about 1.8x shorter than
      // the real car so street speeds use all eight: at 12,000 rpm first ends
      // at 55 km/h, then 68 / 82 / 98 / 117 / 140 / 168 and 200 km/h in eighth.
      ratios: [4.17, 3.37, 2.80, 2.34, 1.96, 1.64, 1.37, 1.15],
      finalDrive: 7.0,
      // 18-inch wheels, rear tyre about 710 mm across.
      tireCircumferenceM: 2.23
    }
  },
  {
    id: 'ferrari-enzo',
    name: 'Ferrari Enzo',
    tagline: '6.0 L V12 · 8,200 rpm · 6-speed paddle shift',
    pro: true,
    engine: {
      idleRpm: 800,
      redlineRpm: 8000,
      limiterRpm: 8200,
      tachRedRpm: 7800,
      launchRpm: 3800,
      peakTorqueNm: 657,
      peakTorqueRpm: 5500,
      engineBrakeNm: 60,
      firing: [
        [0, 1, 0], [60, 7, 1], [120, 5, 0], [180, 11, 1],
        [240, 3, 0], [300, 9, 1], [360, 6, 0], [420, 12, 1],
        [480, 2, 0], [540, 8, 1], [600, 4, 0], [660, 10, 1]
      ],
      sound: {
        banks: [
          { pipeMs: 7.448, pan: -0.45, tune: 1 },
          { pipeMs: 7.644, pan: 0.45, tune: 1.02 }
        ],
        pipeReflection: -0.4,
        pipeDamping: 0.179,
        formants: [
          { hz: 110, q: 1.5, gain: 1.8 },
          { hz: 300, q: 2, gain: 1.0 },
          { hz: 400, q: 3, gain: 0.8 },
          { hz: 750, q: 2, gain: 0.8 },
          { hz: 1300, q: 2.5, gain: 1.4 },
          { hz: 2600, q: 2.5, gain: 1.0 }
        ],
        formantDry: 0.35,
        pulseMsIdle: 3.2,
        pulseMsRedline: 0.55,
        noise: 0.5,
        jitter: 0.02,
        cylinderTrim: 0.25,
        lope: 0.1,
        mufflerHz: [600, 12000],
        bodyHz: 80,
        bodyDb: 8,
        intake: 0.12,
        intakeHz: 1100,
        whine: 0,
        whineRatio: 5,
        crackle: 0.6,
        popGain: 0.5,
        drive: 1.8,
        gain: 0.6
      }
    },
    vehicle: {
      massKg: 1365,
      cdA: 0.7,
      crr: 0.011,
      maxAccel: 9,
      peakPowerKw: 485,
      drivetrainEff: 0.9,
      ratios: [3.17, 2.13, 1.52, 1.19, 0.97, 0.8],
      finalDrive: 4.3,
      tireCircumferenceM: 2.18
    }
  },
  {
    id: 'lamborghini-veneno',
    name: 'Lamborghini Veneno',
    tagline: '6.5 L V12 · 8,500 rpm · 7-speed single-clutch',
    pro: true,
    engine: {
      idleRpm: 1000,
      redlineRpm: 8400,
      limiterRpm: 8500,
      tachRedRpm: 8000,
      launchRpm: 3800,
      peakTorqueNm: 690,
      peakTorqueRpm: 5500,
      engineBrakeNm: 65,
      firing: [
        [0, 1, 0], [60, 7, 1], [120, 6, 0], [180, 12, 1],
        [240, 3, 0], [300, 9, 1], [360, 4, 0], [420, 10, 1],
        [480, 2, 0], [540, 8, 1], [600, 5, 0], [660, 11, 1]
      ],
      sound: {
        banks: [
          { pipeMs: 2.664, pan: -0.45, tune: 1 },
          { pipeMs: 2.845, pan: 0.45, tune: 1.04 }
        ],
        pipeReflection: -0.45,
        pipeDamping: 0.392,
        formants: [
          { hz: 143, q: 1, gain: 0.459 },
          { hz: 787, q: 2, gain: 0.5 },
          { hz: 1285, q: 2.4, gain: 0.6 }
        ],
        formantDry: 0.4,
        pulseMsIdle: 2.697,
        pulseMsRedline: 0.909,
        noise: 0.98,
        jitter: 0.049,
        cylinderTrim: 0.05,
        lope: 0.08,
        mufflerHz: [2924, 3297],
        bodyHz: 119,
        bodyDb: 0,
        intake: 0.12,
        intakeHz: 1000,
        whine: 0,
        whineRatio: 5,
        crackle: 0.8,
        popGain: 0.55,
        drive: 3.4,
        gain: 0.5
      }
    },
    vehicle: {
      massKg: 1450,
      cdA: 0.8,
      crr: 0.011,
      maxAccel: 10,
      peakPowerKw: 552,
      drivetrainEff: 0.9,
      ratios: [3.91, 2.43, 1.7, 1.28, 1.03, 0.85, 0.69],
      finalDrive: 3.9,
      tireCircumferenceM: 2.2
    }
  },
  {
    id: 'audi-rs6',
    name: 'Audi RS 6 Avant (C8)',
    tagline: '4.0 L twin-turbo V8 · 6,800 rpm · 8-speed automatic',
    pro: true,
    engine: {
      idleRpm: 600,
      redlineRpm: 6700,
      limiterRpm: 6800,
      launchRpm: 3000,
      peakTorqueNm: 850,
      peakTorqueRpm: 3400,
      engineBrakeNm: 80,
      firing: [
        [0, 1, 0], [90, 3, 0], [180, 7, 1], [270, 2, 0],
        [360, 6, 1], [450, 5, 1], [540, 4, 0], [630, 8, 1]
      ],
      sound: {
        banks: [
          { pipeMs: 6.0, pan: -0.55, tune: 1 },
          { pipeMs: 7.3, pan: 0.55, tune: 1.04 }
        ],
        pipeReflection: -0.5,
        pipeDamping: 0.28,
        formants: [
          { hz: 82, q: 1.0, gain: 1.2 },
          { hz: 190, q: 1.1, gain: 1.0 },
          { hz: 420, q: 1.3, gain: 1.0 },
          { hz: 850, q: 1.5, gain: 0.8 },
          { hz: 1600, q: 2.0, gain: 0.35 }
        ],
        formantDry: 0.3,
        pulseMsIdle: 4.0,
        pulseMsRedline: 0.65,
        noise: 1.3,
        jitter: 0.07,
        cylinderTrim: 0.07,
        lope: 0.2,
        mufflerHz: [1200, 7500],
        bodyHz: 70,
        bodyDb: 4,
        intake: 0.15,
        intakeHz: 650,
        whine: 0,
        whineRatio: 6.5,
        crackle: 0.5,
        popGain: 0.3,
        drive: 2.5,
        gain: 0.5
      }
    },
    vehicle: {
      massKg: 2110,
      cdA: 0.8,
      crr: 0.012,
      maxAccel: 9.0,
      peakPowerKw: 463,
      drivetrainEff: 0.85,
      ratios: [4.714, 3.143, 2.106, 1.667, 1.285, 1.0, 0.839, 0.667],
      finalDrive: 3.2,
      tireCircumferenceM: 2.28,
      maxSpeedKmh: 250
    }
  },
  {
    id: 'nissan-gtr-nismo-r35',
    name: 'Nissan GT-R NISMO (R35, 2024)',
    tagline: '3.8 L twin-turbo V6 · 7,100 rpm · 6-speed dual-clutch',
    pro: true,
    engine: {
      idleRpm: 700,
      redlineRpm: 7000,
      limiterRpm: 7100,
      launchRpm: 3500,
      peakTorqueNm: 652,
      peakTorqueRpm: 4500,
      engineBrakeNm: 60,
      // 1-2-3-4-5-6 every 120°, banks alternating: each bank fires every 240°.
      firing: [
        [0, 1, 0], [120, 2, 1], [240, 3, 0], [360, 4, 1],
        [480, 5, 0], [600, 6, 1]
      ],
      sound: {
        banks: [
          { pipeMs: 6.4, pan: -0.35, tune: 1 },
          { pipeMs: 6.7, pan: 0.35, tune: 1.02 }
        ],
        pipeReflection: -0.45,
        pipeDamping: 0.32,
        formants: [
          { hz: 110, q: 1.0, gain: 0.8 },
          { hz: 330, q: 1.2, gain: 1.0 },
          { hz: 800, q: 1.4, gain: 1.1 },
          { hz: 1600, q: 1.8, gain: 0.8 },
          { hz: 2800, q: 2.2, gain: 0.35 }
        ],
        formantDry: 0.35,
        pulseMsIdle: 4.0,
        pulseMsRedline: 0.8,
        noise: 1.4,
        jitter: 0.05,
        cylinderTrim: 0.05,
        lope: 0.06,
        mufflerHz: [900, 6500],
        bodyHz: 100,
        bodyDb: 3,
        intake: 0.35,
        intakeHz: 1300,
        whine: 0,
        whineRatio: 6,
        crackle: 0.35,
        popGain: 0.25,
        drive: 3.4,
        gain: 0.4
      }
    },
    vehicle: {
      massKg: 1725,
      cdA: 0.72,
      crr: 0.012,
      maxAccel: 10.5,
      peakPowerKw: 441,
      drivetrainEff: 0.86,
      ratios: [4.056, 2.301, 1.595, 1.248, 1.001, 0.796],
      finalDrive: 3.7,
      // 285/35 R20 rear: about 708 mm across.
      tireCircumferenceM: 2.22,
      maxSpeedKmh: 315
    }
  },
  {
    id: 'bugatti-chiron',
    name: 'Bugatti Chiron',
    tagline: '8.0 L quad-turbo W16 · 6,700 rpm · 7-speed dual-clutch',
    pro: true,
    engine: {
      idleRpm: 700,
      redlineRpm: 6600,
      limiterRpm: 6700,
      launchRpm: 3000,
      peakTorqueNm: 1600,
      peakTorqueRpm: 4000,
      engineBrakeNm: 90,
      // 1-14-9-4-7-12-15-6-13-8-3-16-11-2-5-10 every 45°. Bank 0 is cylinders
      // 1-8 and bank 1 is 9-16, a guess: the real W16 has four banks of four.
      firing: [
        [0, 1, 0], [45, 14, 1], [90, 9, 1], [135, 4, 0],
        [180, 7, 0], [225, 12, 1], [270, 15, 1], [315, 6, 0],
        [360, 13, 1], [405, 8, 0], [450, 3, 0], [495, 16, 1],
        [540, 11, 1], [585, 2, 0], [630, 5, 0], [675, 10, 1]
      ],
      sound: {
        banks: [
          { pipeMs: 6, pan: -0.4, tune: 1 },
          { pipeMs: 6.4, pan: 0.4, tune: 1.04 }
        ],
        pipeReflection: -0.5,
        pipeDamping: 0.32,
        formants: [
          { hz: 70, q: 1, gain: 1 },
          { hz: 189, q: 1.2, gain: 1.764 },
          { hz: 1058, q: 1.6, gain: 0.7 },
          { hz: 1800, q: 2, gain: 0.35 }
        ],
        formantDry: 0.35,
        pulseMsIdle: 5,
        pulseMsRedline: 0.98,
        noise: 0.714,
        jitter: 0.092,
        cylinderTrim: 0.116,
        lope: 0.112,
        mufflerHz: [1619, 11000],
        bodyHz: 118,
        bodyDb: 6,
        intake: 0.2,
        intakeHz: 800,
        whine: 0,
        whineRatio: 6,
        crackle: 0.5,
        popGain: 0.4,
        drive: 2.041,
        gain: 0.36
      }
    },
    vehicle: {
      massKg: 2070,
      cdA: 0.9,
      crr: 0.012,
      maxAccel: 9.5,
      peakPowerKw: 1103,
      drivetrainEff: 0.85,
      ratios: [3.7, 2.4, 1.7, 1.3, 1, 0.8, 0.64],
      finalDrive: 3.3,
      tireCircumferenceM: 2.3,
      maxSpeedKmh: 420
    }
  },
  {
    id: 'porsche-911-turbo-s',
    name: 'Porsche 911 Turbo S (992)',
    tagline: '3.7 L twin-turbo flat-six · 7,200 rpm · 8-speed PDK',
    pro: true,
    engine: {
      idleRpm: 750,
      redlineRpm: 7000,
      limiterRpm: 7200,
      launchRpm: 3200,
      peakTorqueNm: 800,
      peakTorqueRpm: 3250,
      engineBrakeNm: 70,
      // 1-6-2-4-3-5, one firing every 120°: cylinders 1-3 on bank 0, 4-6 on
      // bank 1, so the banks alternate, each with its own turbo and tailpipe.
      firing: [
        [0, 1, 0], [120, 6, 1], [240, 2, 0], [360, 4, 1],
        [480, 3, 0], [600, 5, 1]
      ],
      sound: {
        banks: [
          { pipeMs: 6.4, pan: -0.5, tune: 1 },
          { pipeMs: 7.1, pan: 0.5, tune: 1.05 }
        ],
        pipeReflection: -0.4,
        pipeDamping: 0.34,
        formants: [
          { hz: 110, q: 1.0, gain: 0.6 },
          { hz: 300, q: 1.2, gain: 1.0 },
          { hz: 700, q: 1.4, gain: 0.7 },
          { hz: 1700, q: 1.6, gain: 0.35 }
        ],
        formantDry: 0.4,
        pulseMsIdle: 3.8,
        pulseMsRedline: 0.95,
        noise: 1.6,
        jitter: 0.035,
        cylinderTrim: 0.03,
        lope: 0.02,
        mufflerHz: [420, 5600],
        bodyHz: 100,
        bodyDb: 2.5,
        intake: 0.6,
        intakeHz: 2200,
        whine: 0,
        whineRatio: 6,
        crackle: 0.25,
        popGain: 0.2,
        drive: 2.7,
        gain: 0.5
      }
    },
    vehicle: {
      massKg: 1640,
      cdA: 0.7,
      crr: 0.011,
      maxAccel: 10.5,
      peakPowerKw: 478,
      drivetrainEff: 0.88,
      ratios: [4.89, 3.17, 2.15, 1.56, 1.18, 0.94, 0.76, 0.61],
      finalDrive: 3.02,
      // 315/30 ZR21 rear: about 722 mm across.
      tireCircumferenceM: 2.24,
      maxSpeedKmh: 330
    }
  },
  {
    id: 'new-car',
    name: 'New Car',
    tagline: 'Sound coming soon',
    pro: true,
    soon: true
  }
];
