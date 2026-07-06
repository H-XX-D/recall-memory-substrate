---
title: "JWST Data Driven 3D fly-by wire Exoplanet Chart Plotter"
datePublished: 2026-07-05T21:33:00.423Z
cuid: cmr8b56r200000aji0fnoduba
slug: free-3d-fly-to-celestial-chart
cover: https://cdn.hashnode.com/uploads/covers/6a338dc87bf3ea1f3591dbb9/f4cdb7ec-e0e9-46ea-b7d7-2bb0278bf45f.png
tags: webdev, science, threejs, nextjs, astronomy

---

I won a 27ft sailboat years ago for peanuts and went all out: Dyneema standing rigging, a DIY LiPo battery bank. Man, I miss that boat. I called it Social Distance (I got it around the middle of Covid, blah blah) and later sold it. The point: I was listening to exoplanet podcasts and thought, that boat plus a $2300 MFD package, and voila, Cosmoplot popped out of my ear yesterday. It is still rough, the graphics, the controls, the design, lol, but the bones are solid. If you like this kind of stuff and want to help, that would be awesome.

This is my 3D space chart plotter. You launch from the Sun and fly out to real objects, and every object you see is rendered downstream from actual physics, computed from real NASA survey data, not painted by hand. Nothing on screen is decoration pretending to be data.

The inputs are real NASA surveys: the NASA Exoplanet Archive for system and stellar parameters, and JWST spectra served through MAST for atmospheres. Pick a planet and you get a derived physics profile: likely interior composition, habitable-zone placement, atmospheric escape regime, a transmission-spectrum inference from real JWST data, and how detectable its heat would be to JWST.

Live: [cosmoplot.io](https://cosmoplot.io). Source: [github.com/H-XX-D/Cosmoplot](https://github.com/H-XX-D/Cosmoplot).

## Two rules

The whole project runs on two rules.

**Numeric truth stays with the source.** Every physical parameter comes from a real NASA survey: the NASA Exoplanet Archive for system and stellar parameters, and JWST spectra via MAST for atmospheres. Everything the app computes is derived from those values with a published relation, and it is labeled as derived, not observed.

**Every value carries its provenance.** Each number belongs to a tier, and the tier is shown next to it:

| Tier | Meaning | Example |
| --- | --- | --- |
| Observed | Straight from the survey | Planet radius, orbital period, host temperature |
| Derived | Computed from observed values by a law | Bulk density, surface gravity, equilibrium temperature |
| Inferred | Estimated from a population relation | Interior composition class, mass forecast from radius |
| Proxy | A deliberately simplified stand-in | Magnetosphere strength |
| Artistic | A rendering choice, no observational claim | Surface texture, corona glow |

Once you make that split explicit, the app becomes honest by construction. A rendered planet can never be mistaken for a photo, and a population estimate can never be mistaken for a measurement.

## The astrophysics

The relations are standard and cited at the point of use. A few of them:

*   **Interior composition** is read from the mass-radius point against the reference curves of Zeng, Sasselov & Stewart (2016), `R/Re = C (M/Me)^(1/3.7)`, with C set by composition (iron 0.86, Earth-like 1.00, rock 1.07, water-rich above).
    
*   **Habitable zone** follows the stellar-flux limits of Kopparapu et al. (2013), with the boundary distance `d = sqrt((L/Lsun) / S_eff)`.
    
*   **Earth Similarity Index** uses Schulze-Makuch et al. (2011) over radius, density, escape velocity, and equilibrium temperature.
    
*   **Atmospheric escape** is screened with the Jeans parameter evaluated at the exobase, not the surface, because for a puffy hot atmosphere the large scale height lifts the exobase well above the surface and changes the answer.
    
*   **Transmission spectra** are inverted with scale-height physics, `H = kT/(mu g)`, on real reduced JWST spectra to estimate the mean molecular weight and separate a light hydrogen envelope from a heavy or cloudy one.
    
*   **White dwarfs** use the degenerate mass-radius relation of Nauenberg (1972) shown against the real Tremblay et al. (2019) Gaia sample.
    

Rather than reporting single derived values, the app draws each input from its survey error bars with a per-planet seeded sampler, recomputes the full derived chain thousands of times, and reports the 16th, 50th, and 84th percentiles. You get an interval, not false precision.

## Testing then deleting my own theory

I did not start here. I started with a phenomenological "correction" of my own, a tidy little framework I was fond of. Then I tested it against real catalogs. It failed my own tests: negative R-squared on one dataset, a coupling parameter that only worked if I let it change sign per situation, cross-checks that did not hold. So I threw it out and kept only standard, published relations, and I went back through the committed system write-ups and stripped the framework in favor of actual escape physics.

That was the moment the project became more than puff puff pass. I would rather propagate boring correct physics than incorrect, aesthetically pleasing propaganda, because feelings, beliefs, and confidently wrong AI have replaced the scientific method for the majority. Building the provenance system forced me to be honest about which was which.

## Stack

Next.js (App Router), React 19, TypeScript, three.js via React Three Fiber, deployed on Vercel. Data from the NASA Exoplanet Archive TAP service, with JWST transmission spectra from MAST for supported targets.

## Thanks, and an ask

Thanks for checking it out. I got carried away because I thought it was cool, and I shared it for the same reason. I hope you enjoy it, find it useful, and learn, as much as I did building it for you. If you want to help, whether that is a fix, a dataset, or just a bug report, you become a non-zero participant in a brighter humanity.

## P.S.

If you like the web app and want to throw me a bone, install [recall-memory-substrate](https://github.com/H-XX-D/recall-memory-substrate). It will change the way you work with agentic AI, pinky swear.