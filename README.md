# stl2gcode - Swift Box

**Live tool: https://s7711.github.io/stl2gcode/**

A browser tool that turns a flattened, nested panel-layout STL (the kind
SketchUp exports once you've laid all your parts out flat, ready to cut) into
G-code for a Duet/RepRapFirmware CNC router. Drag in the STL, tune a few
settings, download two G-code files, cut.

No install, no server - `index.html` runs entirely in your browser. Nothing
you load or generate leaves your machine.

## Background

This started from a simple annoyance: a SketchUp design has no way to get its
geometry onto a CNC machine without either re-drawing it in a CAM package or
hand-entering every vertex's coordinates. Fusion 360 can do the job, but its
lead-in/lead-out entry style doesn't suit wood well, and its rough+finish and
ramped-entry features - genuinely useful ones - come wrapped in a lot of CAM
machinery for what's fundamentally a flat-panel box. This tool exists to do
just the flat-panel case, directly from an STL, with those specific
techniques (ramped entry, rough+finish passes, round-joined corners) built in
because they're what actually mattered for cutting this box on a Workbee -
not because they're a complete CAM feature set.

A few physical realities shaped it directly: the router is manually switched
(no spindle control in the G-code), the machine isn't rigid enough to trust a
full-width finishing cut every time (hence rough+finish as a real option, not
just a nice-to-have), and the hold-down screw holes exist because the sheet
needs pinning down before the heavier outline cuts run - which is also why
there are two separate G-code programs instead of one.

## What it assumes about your STL

This is **not** a general-purpose CAM tool. It expects a specific, simple
shape of input:

- **Flat panels only.** The STL should already be a set of flat parts, each
  extruded to one common material thickness, laid out side by side in the XY
  plane (exactly what you get from SketchUp when you've unfolded/arranged a
  panel-built design like this swift box). It does not slice or contour a
  general 3D shape - if your STL is a real 3D solid rather than a flat nested
  layout, this tool is the wrong one for it.
- **Pockets are supported.** If a panel has a shallower recess cut partway
  into its top face (not all the way through), the tool detects it as a
  pocket, clears the interior with a raster toolpath, and finishes the wall -
  see "Pockets" below.
- **True 3D contours are not supported.** Curved/sculpted surfaces, varying
  depth across a face, anything that isn't "flat panel, optionally with a
  pocket" - out of scope. Don't feed it a 3D-carved shape and expect a
  sensible result.
- **Only a flat end mill is implemented.** The tool-shape dropdown has
  ball-nose and V-bit options visible but disabled - the geometry/offset math
  only accounts for a constant-radius flat cutter right now. Don't rely on
  the other options until they're actually enabled.

## How it works

1. **Open `index.html`** in a browser (just double-click it, or serve the
   folder with any static file server / VS Code Live Server).
2. **Drop your STL** onto the page. It parses the mesh, finds each physical
   part by triangle connectivity, and works out:
   - Each part's outer outline.
   - Every hole in every part, classified as either a small hold-down screw
     hole (below the area cutoff, circular) or a real feature hole (like a
     swift entrance) that has to be part of the finished shape.
   - Any pockets (partial-depth recesses).
3. **Check the preview.** Blue = part outlines, red = hold-down holes, orange
   = feature holes, green = pockets, with a small crosshair + arrows marking
   the work origin and its X/Y directions. Sanity-check this against what you
   expect before generating anything.
4. **Tune the settings** (see below) if the defaults don't match your setup.
5. **Download both files**:
   - `01_holddown_holes.gcode` - bores every small screw hole through the
     sheet, so you can screw the stock down to your spoilboard.
   - `02_outlines.gcode` - cuts every feature hole, clears every pocket, and
     cuts every part's outer profile, in that order per part.
6. **Run them in order**: drill the holes program first, physically screw the
   stock down through those holes, *then* run the outlines program. The two-
   program split exists specifically so the sheet is pinned down before the
   heavier cutting starts.

**Always check the generated G-code in a simulator before cutting** - see
"Checking the output" below. This tool has already had real bugs caught this
way (wrong cut direction, a diagonal shortcut through material between
passes) - trust the simulator, not just the fact that it ran without error.

## Settings

| Setting | What it does |
|---|---|
| Tool diameter / shape | Cutter diameter for radius compensation. Shape is flat-only for now. |
| Material thickness | Auto-read from the STL's Z extent; override if needed. |
| Stepdown per pass | How much depth each pass removes. |
| Cut-through extra | Extra depth past material thickness so through-cuts fully separate. |
| Ramp entry angle | Descends into each pass along the path instead of plunging straight down. Circular holes always helix in one turn regardless of this. |
| Rough pass extra offset | Cuts a rough pass this far outside/inside the true line first, then a finish pass at the true line. Set to 0 for a single finish-only pass. Automatically skipped wherever there isn't enough clearance for it to make sense (e.g. the small hold-down holes, or two features positioned close together - watch for a "rough pass skipped" comment in the output). |
| Cutting feed rate / Plunge rate | XY cutting speed and Z plunge speed. No coolant on this machine, so keep these conservative and tune by ear. |
| Safe travel height | Clearance height for rapid moves. Must clear anything protruting above the material - hold-down screw heads, clamps, etc - since Program 2 runs with screws already in. |
| Pocket stepover | Spacing between raster passes when clearing a pocket's interior, as a % of tool diameter. Not used for outline/hole perimeter cuts - those are always a single pass, since a perimeter cut doesn't have an "interior" to clear. |
| Small-hole area cutoff | Anything smaller than this (and circular) is treated as a hold-down screw hole rather than a real feature. |
| Work origin | The point in the STL's own coordinates that becomes machine (0,0). Auto-set to the layout's bottom-left corner; override if you zero your machine somewhere else. **Z=0 is always the top of the material, not the spoilboard** - zero your Z axis on top of your stock. |

## Checking the output

Don't skip this. Before cutting real material, check the generated G-code
with at least one external viewer/simulator - a second, independent read on
the toolpath is exactly how the diagonal-cut-through-material bug got caught
during development. Two free options:

- **[ncviewer.com](https://ncviewer.com/)** - a 3D toolpath viewer. Good for
  spotting anything geometrically wrong: a path that doesn't look like your
  part, an unexpected jump, a move outside the sheet.
- **[nc2image2](https://s7711.github.io/nc2image2/)** - renders a depth-map
  image of the simulated cut (white = uncut, black = deepest). Good for
  spotting depth problems specifically: a feature that's shallower than it
  should be, a rough pass overlapping into where it shouldn't.

If either shows something that doesn't match what you expect from the
preview in this tool, stop and figure out why before running it on the
machine.

## Known limitations

- Offsetting uses a straightforward mitre-join algorithm with a round-join
  fallback for corners tighter than a set miter limit, plus point-cluster
  simplification for noisy STL tessellation - not a fully general/robust
  polygon-offset library. It's been tested against this box's actual
  geometry (including a deliberately awkward acute-angle notch), but an
  unusual shape could still expose an edge case it doesn't handle well.
  Check the preview and the simulator output for anything that looks wrong.
- Two independently-valid features positioned close together (e.g. a small
  island inside a larger hole) can still end up with very little standing
  material between them once rough-pass margins are added on both sides,
  even though neither feature is individually a problem. Watch tight
  clearances between adjacent features, not just each feature on its own.
- No spindle control in the G-code (no M3/M5) - this assumes a manually-
  switched router.
