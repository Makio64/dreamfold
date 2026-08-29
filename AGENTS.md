# Working on this codebase

A three.js app that stands a camera in a real city on Google's photorealistic 3D
tiles and folds the city over the viewer's head, with the bend written in TSL and
run on WebGPU. Read the [README](README.md) for what it does; this file is how it
is built.

No framework, no state library, no build step beyond Vite. Plain ES modules,
plain DOM. Every heading below is a decision with a plausible-looking wrong
alternative — that is why it is written down.

## Commands

```bash
pnpm install
pnpm dev              # vite on :5181 (PORT overrides)
pnpm build            # -> dist/   (deliberately drops the tile credentials)
```

No test suite, no linter. Verify by running it — see *Verifying a change*, which
has the one trick you will need.

## Layout

```
src/
  main.js                 wiring only: UI ↔ world. No logic.
  geo.js                  a pole-safe East-North-Up frame
  tilesAuth.js            Cesium Ion / Google Maps key resolution + verification
  world/
    World.js              renderer, tiles, loader camera, ground probe, post chain, the loop
    Frame.js              ECEF → local metres at the chosen corner
    fold.js               the bend: uniforms and the TSL graph
    sky.js                sun and gradient — one function, two callers
    clouds.js             raymarched volumetric clouds, folded by the bend's inverse
  camera/
    Rig.js                a head on a tripod that walks; pointer and keys
    shots.js              the eight dream-training moves, as keyframed curves
  data/
    destinations.js       where the city is allowed to fold
    mapLinks.js           pasted map links and codes → lat/lon, offline
  record/Recorder.js      frame-locked WebCodecs capture
  ui/UI.js                all of the DOM
public/og.png             the share card, 1200×630 — a captured frame of the fold
public/icon-180.png       the touch icon, from the drawn fold in tools/og-card.html
tools/og-card.html        draws the touch icon; not loaded by the app. `og.png`
                          is a real take, kept at exactly the size
                          `og:image:width` promises or a scraper may drop it.
```

`geo.js`, `tilesAuth.js` and `data/mapLinks.js` came over unchanged from
[threejs-cinematic-world-zoom](https://github.com/Makio64/threejs-cinematic-world-zoom).
Fixes worth having probably belong in both.

## How a fold works

```
UI place picked
  └─ world.setDestination()
       ├─ new Frame( ellipsoid, lat, lon )   ECEF → local East-Up-South
       ├─ tiles.group ← frame.toLocal        the city moves to the origin
       ├─ rig starts high and pitched down, targets the roofline
       └─ state = 'loading'
  ...the loop...
       ├─ probeGround()   until the tile pipeline goes quiet
       └─ state = 'ready'
UI Start pressed (after the ground probe settles)
  └─ world.playShot( 'dream' )   the hinge sweeps in, the street folds over
```

`load-model` swaps every arriving tile onto `foldMaterial`, so a tile that
streams in halfway through a move is folded on the first frame it is drawn.

## The load-bearing decisions

Change these only on purpose.

### The bend

**The whole city is moved to the origin.** ECEF coordinates are ~6.4e6 and a
float32 vertex shader has about half a metre of resolution there. `Frame.js`
gives the tile group the ECEF → local transform so three composes it with each
tile's matrix on the CPU in float64. Everything downstream is in local metres
because of this and none of it survives without it.

**The bend must be evaluated at the floored angle, not just divided by it.**
`sin(θ)/θ` and `(1−cosθ)/θ` are how the roll is written without ever forming the
radius `1/k`, which is ~1e9 at the start of the animation. Flooring only the
denominator gives `sin(0)/1e-6 = 0` where the limit is 1, collapsing the city
onto the hinge circle — which looks exactly like a tile-loading failure.
`1−cosθ` is written `2sin²(θ/2)` for the same reason.

**θ is capped at `fold.curl` and the remainder runs on straight.** A *cap*, not
a clamp: a clamp piles the leftover arc length up at the limit. Without it,
coarse tiles tens of kilometres out wind several times around the roll and come
back down through the camera; with the curl at a quarter turn it is what makes
the `tube` shape.

**`bend` and `foldLength` are one number to the shader and two to the hand.**
Curvature is `bend · π / foldLength`. Keep both: `bend` is the animation channel
(0 to 1, driven by every move) and `foldLength` is what "fully over" costs — 1900 m
is a horizon lifting, 30 m is the street creasing on a ten-metre radius, which is
not reachable by bending harder. `setFoldLength` re-spends the current bend at
the new length, because the uniform holds the product and not the pair.

**A shape is an axis, a curl, and whether it cuts.** `FOLD_SHAPES` in `fold.js`
is the only place that grouping lives. Three entries are not obvious from the
axis list: `tube` is the bowl stopped early, `box` is the `double` axis taken
the whole half turn, and `dream` is the plain fold axis stopped six per cent
short and cut at the plane over the viewer.

**The bend is branch-free at the hinge.** `t = 0` collapses to the identity, so
the pavement comes out bit-identical rather than approximately identical. A
`select` on `t > 0` puts a seam along the hinge in every tile that straddles it.

**A shape that declares `cut` stops its geometry at the plane over the viewer.**
Past the curl the leftover arc runs on straight — in `fold` that roofs the sky
behind the viewer — but a shape whose ceiling is tens of metres cannot keep it:
the run-on carries kilometres of horizon-grade city over the top at roll height,
so every building taller than the ceiling comes back down *through* the
pavement. `foldMaterial` discards fragments whose ground-plan coordinate has
crossed zero. A fragment discard and not a vertex clamp, because a clamp piles
the far city into an edge-on plane through the camera and a triangle straddling
the cut still needs its near half drawn. The test is a **pair** — the coordinate
after the bend against the same coordinate before it — and only a sign
disagreement is a crossing: on the directional axis the city behind the viewer
lives its whole life at a negative coordinate, so cutting on the bent one alone
erases everything `dream` exists to keep. `bowl` shares the hazard on paper and
does not cut on purpose: that crossing *is* the dome closing.

**`double` leaves a flat wedge broadside to its axis.** Points perpendicular to
the fold direction have `s ≈ 0` and never bend, so a large yaw on a wide lens
ends a `double` shot pointed at open horizon. Not a defect — it is what makes
the enclosure a *street* with two open ends rather than a barrel.

**City height stays at one-to-one.** There is no vertical-exaggeration uniform
or shot channel. Moves that climb crane the real camera.

### Tiles and streaming

**`displayActiveTiles` is deliberately `false`, and there is a second camera
instead.** On a planet-wide tileset the tiles nobody looks at never refine, so
keeping them all would fill the scene with root-level continents — standing in
Paris means standing inside a brown mesh the size of France. The loader camera
hangs over the site looking down, framing the disc the fold can reach. A frustum
both refines *and* displays; this one never renders.

**`autoDisableRendererCulling` stays on.** A bent vertex leaves its bounding
sphere kilometres behind, so every per-object frustum test is wrong about this
geometry. It is the default; turning it off empties the sky at exactly the
moment the effect starts.

**`TilesFadePlugin` runs with its material manager swapped out.** The stock
plugin crossfades LODs by patching GLSL through `onBeforeCompile`, which a node
material never calls — under WebGPU that half fails silently. Its scheduling
half is renderer-agnostic, so `_initTiles` drops `NodeFadeManager` from
`fold.js` over the plugin's private `_fadeMaterialManager` and `foldMaterial`
carries the same Bayer stipple — but *always in the shader*. The stock
`FEATURE_FADE` define is deliberately not reproduced: under WebGPU every define
flip is a pipeline recompile, several a second while tiles stream, and at the
resting uniforms both discards are vacuously false. Coupled to
3d-tiles-renderer 0.5.1's plugin shape; breaks loudly in `setFade` if an upgrade
moves it. Fades run on the shot's clock, not the wall's: everything goes through
`World._updateTiles( dt )`, which backdates the fade manager's `_lastTick` before
pumping the tiles. Upstream steps its crossfades off `performance.now()`, which
would collapse every fade into a single frame of a recording — a recorded frame
takes far longer to render than it lasts — and run them out during `settle()`,
which pumps for seconds while the shot stands still. Completing them on every
seek is the other failure (a 420 ms dissolve becomes a hard LOD swap). `seek()`
treats a negative step or a jump past half a second of real time as a cut; the
live loop only clamps to `1/20` s so a tile-parse hitch cannot abort every
in-flight crossfade.

**The ground probe takes a low quantile of a spread of rays, not a median.**
Over Midtown more than half of any ring of downward rays lands on a roof, so the
median *is* a roof. The same first ray records the top of whatever stands at the
origin and hands it to `rig.floorHeight`, so a coordinate on a building puts the
camera on top of it rather than inside it. **It keeps answering until the
pipeline is quiet** — the first mesh under the origin is a continent-wide shell,
and only the last answer is the street.

**Street framing is authored, not inferred from height.** Low downward hits
cannot distinguish asphalt from a park, water or the deck below an overpass. The
dream-training position uses a visually checked `streetCenter: true` coordinate;
`findOpenGround` preserves one when it is low and is otherwise a roof-escape
fallback. Do not replace that curation with a wider ray search and call the
lowest result a street.

**The renderer comes up before the credential does.** Setup is answered over the
sky rather than over black. Without a key `_initTiles` registers no auth plugin,
so the tileset has no URL and nothing reaches the tile service until
`reauthorize()` hands it a token that passed `verifyTileAuth`.

### Sky, haze and clouds

**Haze is a function of the ground plan, not of the camera.** Distance-to-camera
fog undoes itself exactly when it is needed — the fold brings the far edge to
within a few hundred metres of the lens — so the rim where the tiles run out
would arrive in shot perfectly clear. `fogFar` is *inside* `CITY_RADIUS` on
purpose: a haze finishing past the rim leaves a hard line across the horizon.

**The sky and the haze are one function, sampled twice.** `skyColor` in `sky.js`
is evaluated by `scene.backgroundNode` along the pixel ray and by the haze in
`foldMaterial` along the ray to the *bent* fragment — which for any given pixel
is the same ray. A fully hazed tile is therefore identical to the sky behind it
at whatever elevation the fold lifts the rim to. What it must never become is a
*copy*: a second gradient tuned to match drifts on the first edit and the rim
comes back as a silhouette. Only the background samples the sun's disc, or a
half-hazed facade lined up with the sun grows a ghost sun. `fogColor` is the
root — the horizon exactly — and the zenith, cloud bodies and haze all derive
from it, so one swatch moves the whole picture.

**The clouds are a raymarch in bent space, decoded to flat space per sample.**
`clouds.js` rebuilds each pixel's ray from scene depth, marches it, and
composites by transmittance — which is what lets a tower stand in front of one
cloud and behind another. The view ray is only straight in bent space, so the
march happens there and every sample is mapped back through the closed-form
inverse to look the density up: three regions (flat / arc / tangent), so a
sample has at most two flat pre-images and their densities *add*, because a fold
genuinely overlaps space. Looks like fat to trim and is not: the caustic fade
applies only to the *rolled* branch (fading the flat branch empties the sky over
the camera at full bend); the density dissolves inside the same
`fogNear`/`fogFar` band the tiles do, which keeps the rim invariant without
putting clouds into `skyColor`; and the slab tops out under the roll radius,
because a layer above the axis dives instead of wrapping.

**The march does not run at frame resolution, and that is the frame budget.** Up
to five fractal-noise evaluations per step over forty steps, per marched pixel —
at full resolution on a retina window it costs more than the rest of the chain
put together. So `clouds.js` returns *two* nodes: `layer`, the march in its own
`MARCH_SCALE` target with radiance premultiplied in rgb and transmittance in
alpha, and `composite`, that layer read back bilinearly over the scene at full
resolution. The city is never resampled, only the cloud over it — the one thing
in shot with no edge sharper than the blurs downstream keep anyway. The alpha
rescale against `MIN_TRANSMITTANCE` happens in the composite, *after* the
filter, because rescaling before it is not monotonic across the interpolation.

**The clouds ship off, and the coverage slider is not the switch.** `cloudsEnabled`
starts false; the Clouds checkbox is what puts the pass and its two targets into
the chain. The uniform branch on `coverage > 0.003` skips the marching at the
zero position but cannot skip the targets, which is why there is a rebuild at
all. The slider must not become the switch — it is a shot channel, and
rebuilding from a drag would recompile several times a second. Consequence: with
the pass off, the Clouds slider moves a uniform nobody reads.

**The rest of the cloud plumbing is deliberate.** Inside a post pass the
`camera*` TSL built-ins describe the full-screen quad's orthographic camera, so
the scene camera's matrices come in as explicit uniforms and the position is
read off the world matrix's translation column. `RTTNode` frees nothing on
dispose, so `_initPost` releases both `renderTarget`s by hand. The march jitter
is `interleavedGradientNoise` of the pixel coordinate — static, so a seeked
recording gets the same frame twice — and the drift rides `sky.time`.

**The sun is authored off the fold axis, not off north.** `SkyState.aim` runs
from `World.setBearing`, so the light swings with the hinge and every take opens
lit the same way; an absolute compass sun would sit behind the camera in half
the cities. Elevation drives the palette (`sunColor`, solved on the CPU per
change), which is what keeps a low sun *warm* rather than merely low.

**The cloud clock is seeked, like `swayTime`.** `sky.time` advances with the
live loop's dt and is set absolutely in `World.seek`, divided by `SHOT_RATE`. A
capture renders slower than real time, so clouds on the wall clock would crawl
at encode speed. Anything else time-based in the sky rides the same uniform.

### The post chain

**The display transform is Khronos PBR Neutral, not a film curve.** The chain is
HDR — every RTT is half-float, which is what lets `skyColor` write the sun past
white and the bloom threshold at 1.0 find it. What must not be treated as HDR is
the *tiles*: Google's mesh is photographs, printed, with a camera's S-curve
already in them. A scene-referred film transform develops that negative twice.
AgX (what this used to run) hangs its shoulder over Paris limestone and returns
chalk — the density is gone rather than misplaced, so the exposure slider cannot
reach it. Neutral is the identity below 0.8 and compresses only above, so the
photographs print as photographed and only the authored-past-white things roll
off. `toneMappingExposure` is therefore 1, not a fraction: the fraction was AgX's
milk being pulled back.

**The bloom is thresholded at 1.0, and the sky is authored past it.** The tiles
never reach white; the sun's disc and the heart of its glow are written above
1.0. Lower the threshold and every pale facade turns to fog; dim the disc below
1 and the glow pass is four render targets producing nothing.

**The live preview is capped at `MAX_PIXEL_RATIO` (1.5), not the device's 2.**
Everything expensive here is per pixel, so this is the frame budget more
directly than anything else. The browser downsamples into the CSS box and this
scene has no thin high-contrast edges to alias. Captures are unaffected —
`setCaptureSize` takes its own ratio and `Recorder` supersamples on its terms.

**The clouds, the tilt-shift and the glow are rebuilt into the chain, not dialled
to zero.** A raymarch and two targets, a half-resolution gaussian, and a mip
chain — none gets cheaper for being invisible. `setCloudPass`, `setTilt` and
`setGlow` rebuild `RenderPipeline.outputNode`, and the three are the Render
group in the settings: a list of costs, in chain order, with the matching
strength sliders under Look. The vignette and the grade are a handful of
instructions and stay in.

**Rebuilding the post chain disposes the old one.** The pass, the cloud RTTs,
the gaussian's two targets and the bloom's mip ladder are unreachable once the
graph is replaced. `_passes` exists so a checkbox does not leak a screenful of
framebuffers per click.

**There is no depth of field, and that is the decision.** A `DepthOfFieldNode`
was in the chain and is gone: a circle-of-confusion pass, a blur of that and two
full-frame bokeh passes, spent softening a picture the fold had already
flattened — a focal plane has nothing to say once the whole frame has arrived at
the same distance. `focus`, `focalLength` and `bokeh` went with it, along with
the focus-follows-stance move in `setStance` and the matching shot channels.
Putting it back means restoring the uniforms, the rebuild, and a
`getTextureNode()` on its output where the gaussian reads it.

**Tilt-shift is not a nicety.** It is the only blur left and the only one that
ever read at full fold: a screen-space wedge is what puts atmosphere back into
the top and bottom of the frame. Ships at 15%.

**`gaussianBlur`'s input has to stay a texture node.** It runs its argument
through `convertToTexture`, which passes a texture or pass node straight through
and wraps anything else in an RTT. Insert a node in front of it that is neither
and the blur buys a full-resolution half-float target and a fullscreen copy per
frame to reproduce a texture that already exists.

**`chromaticAberration`'s centre must be passed explicitly.** The signature
defaults it to `null` and the docs say null means screen centre; `nodeObject( null )`
is null and the node calls `.build()` on it. One TSL TypeError and the whole
scene renders nothing.

**The tiles are drawn unlit.** Google's mesh was photographed with the sun in
it. A second light is visible the moment the fold turns a roof face-down.

There is an FPS readout in the bottom right (`UI.setFps`, fed the loop's `dt`) to
judge all of this by. It averages over half a second — a single hitch on a steady
sixty reads as forty-two — stays up while a move plays, and goes away during a
capture, where the live loop is stopped and the last figure would be a lie.

### The rig and the walk

**Walking pans the whole effect.** `_followCenter` puts `fold.center` on the
camera every frame and drags the loader camera with it, so the hinge stays the
same distance ahead and there is always city to fold. Every horizontal term in
`bendPosition` and `foldPoint` is measured from that centre; the three missed
the first time — the radial axis, the haze radius, and the CPU twin — each fail
differently, so change them together. The *frame* origin does not move: that is
the float32 anchor. `MAX_WALK` is where the local frame stops being flat enough
to fold on, not where the city runs out.

**`groundY` has to stay under `fold.center`.** The datum is the height the bend
measures every vertex from, so leaving it on the arrival coordinate makes local
relief count as *height above the pavement*: walk toward the Peak in Hong Kong
and 400 m of hillside is treated as 400 m of building, which rescales the whole
roll — the far side of the city stops coming over and curls back down under the
viewer. `followGround` re-probes around the camera and `_settleGround` eases
`groundY` onto it, damped, because a datum that stepped would step the vertical
exaggeration with it.

**`rig.floorHeight` is derived from `_floorTop` every frame, and eased
asymmetrically.** The datum underneath is moving, so it cannot be stored — and
assigning it straight from the probe teleports the camera the height of a
building every time a reading crosses a roof edge. Rising is quick (the
alternative is the lens passing through a wall), falling is slow (a roof edge is
a cliff).

**Ground following is keyed on distance moved, not on the keys being held.** A
shot's dolly writes `rig.x/z` directly and never sets `_walking`; gating the
re-probe on the keys meant a 600 m authored move re-centred the fold on ground
it had never measured. `PROBE_STRIDE` is the leash.

**`rig.setGround` clamps by shortening the step, not by projecting onto the
boundary.** Renormalising the destination turns forward motion at the limit into
a full-speed orbit, because the component that ran past the edge comes back as
tangential travel.

**A dolly cannot make a dolly zoom here.** The fold is centred on the camera, so
backing away takes the arc with you. `vertigo` pulls the *hinge* in as the lens
closes instead, keeping a small dolly only for parallax on the real buildings at
the frame edge.

**`FOLD_TILT` is smaller than it wants to be.** Tracking the fold all the way up
fills the frame with ceiling, which reads as an aerial photograph. The shot works
while there is still a flat street at the bottom to be upside down relative to.

### Shots

**A shot drives the same setters the sliders do.** That is what lets the panel
follow one and lets the viewer take the controls back mid-move. A move that
could not be reached by hand would be a move nobody could adjust.

**Every control that writes a channel a shot also writes must stop the shot
first** — the `manual()` wrapper in `main.js`, plus `rig.onChange`. A shot
rewrites its channels every frame, so a manual change underneath one is
overwritten on the same tick: the bend slider springs back on release and Reset
is undone before it is seen. The sky colour and the three post toggles are the
exceptions, because no shot drives them.

**`_advanceShot` runs after `rig.update` and uses the immediate setters.** The
curve in the shot *is* the easing; running it through the rig's damping as well
rounds off every key. The dolly is measured along the bearing the shot *opened*
on, so a yaw track turns the head without curving the track.

**`_applyShotAt` is absolute and `_advanceShot` is a step onto it.** They have
to be the same function or the recording and the screen are two different moves.
Every channel is a pure function of `t` — nothing integrates — which is what
makes `seek` legal at all. `rig.swayTime` is seeked with it or the file jitters
against a clock the rest of the frame does not share.

**Author shot pitch against `foldTilt`.** The rig adds up to ten degrees of its
own elevation at full bend, on top of the pitch track. Two shots were framed on
empty sky before this was accounted for — and a `tube` has no ceiling by
construction, so a lens pointed up the shaft finds the one part of the scene
with nothing in it.

## Recipes

**A new destination** — one entry in `DESTINATIONS`. Required: `id`, `name`,
`place`, `country`, `cat` (emoji), `lat`, `lon`, `groundH`, `geoidN`, `bearing`,
`foldStart`, `street`, `rooftop`. Optional `move` names a shot the place exists
for, and the shot brings its own shape — only `paris-cesar-franck` has one, and
a second wants a reason as good, because a place that quietly replaces the move
somebody chose is a picker that undoes itself. Then go and look at it: prefer
the centreline of a broad street with a long view, mark a verified one with
`streetCenter: true`, and pick `bearing` down the grain of the grid so the hinge
crosses the streets square.

**A new fold shape** — usually one entry in `FOLD_SHAPES`. Decide `cut` on
purpose (see the cut paragraph). A genuinely new *axis* is a fourth `mix` on
`state.mode` in `bendPosition`, and stays continuous with the others for free.

**A new move, or re-tuning one** — one entry in `SHOTS`. `short` and `note` are
what the picker draws, so both are required. Give each channel its own curve and
let them land at different times — every channel arriving together is what an
automated transition looks like, and none of them arriving together is what a
shot looks like. Then watch it, because the arithmetic that reads well on paper
(`bend` to 1, `pitch` up) is the arithmetic that frames the sky.

**A move that needs a curl its shape does not have drives the channel itself.**
`_applyChannel` takes `curl` in degrees like any other; `90degree` is the one
move that uses it. A shape is the other way to say it, and the right one when
the *interface* should offer it. Either way the shot's `shape` runs first, so
the track has the last word from the first frame.

**A move that does not move still has to author the channel.** `gaze` holds
`height` flat rather than omitting it — leaving a channel out leaves it wherever
the viewer last dragged the slider, so a move defined by *not* craning would
open two hundred metres up half the time.

**`start` is a trim, and two moves are barely trimmed.** Six of the eight open a
quarter in because their first stretch is an ordinary street. `flight` opens at
0.08 because its first stretch *is* its first beat, and `fold` because its eager
bend leaves no establishing stretch to skip.

**Shake is a fifth of what the curves originally said, and five moves have
none.** `Rig.apply` squares off the stroke, so the old amplitudes read as a
camera being dropped. If the stroke is reshaped again these numbers move with it
— they are a pair. `fold`, `gaze`, `approach`, `dream` and `90degree` author
`HELD_STILL` rather than omitting the channel.

**`linear` exists for one track.** Every other curve arrives somewhere and
stops, which is what a camera move does. `flight`'s dolly is a cruise; easing its
end puts the brakes on an aircraft.

**`BASE_LOOK` is the authored base; `ui.values` is live state.** Everything
writes the live one, so reading the base back out of it returns whatever
happened last. `applyBaseLook` runs after `applyShape` on arrival and reads the
frozen one, which is why the base curl survives the shape preset.

**`ui.move`, `ui.shape` and the per-move height endpoints are live state read at
the moment a move starts.** `world.onShot` writes them back, because the
recorder calls `playShot` without going through the bar. `on.move` exists only
to stop a running shot.

**A new art-direction control** — one entry in `LOOK_CONTROLS` (label, range,
formatter) and one line in `LOOK` in `main.js` turning the raw number into a
call on the world. The row builds itself. Anything that should also move when a
*preset* moves calls `ui.setLook( key, value )` so the readout does not lie.

**Re-tuning the look** — `FOLD_LENGTH`, `CITY_RADIUS`, `LOADER_HEIGHT`,
`FOLD_TILT` at the top of `World.js`, and `rig.fov`. `CITY_RADIUS` has a cost
attached: it sets the loader camera's field of view and therefore how much of
the planet is streaming. `FOLD_LENGTH` has a twin: the `foldLength` row in
`LOOK_CONTROLS` is its base value and its ceiling, and the readout lies if they
disagree.

### Interface

**The bar names things; Start plays them.** One line along the bottom — Location,
Bending, Animation, Height, Start, Rec — plus a gear holding the bend, the crane,
the stance and the art direction. The sibling project's arrangement, ported class
for class.

**Menu open state lives as a class on `<body>`** (`shapes-open`, `moves-open`,
`settings-open`), not on the popover — that is what lets the backdrop, the caret,
the trigger's underline and the panel all answer one flag without holding
references to each other. `_toggleMenu` closes whatever else is open first:
there is only ever one surface over the picture.

**Hiding chrome takes `visibility`, not `opacity` and `pointer-events`.** The
`#ui button, #ui input, #ui a, #ui li { pointer-events: auto }` allowlist carries
an id, so it beats an inherited `none` from any `body.chrome-hidden ...`
selector. Fade the bar without hiding it and every button stays hit-testable at
zero opacity — a drag across the bottom of the picture opens the destination
card instead of moving the camera. For a control that must stay dim and inert
but live-looking, use the `disabled` attribute, as `setRecording` does.

**Every full-screen overlay needs a z-index above the bar.** `.bar` is 7 and
`.settings` is 8, so a `position: fixed` card at `z-index: auto` paints *under*
them however late it appears in the DOM. `.scrim` is 20, `.keyprompt` is 30.

**Setup is two screens and the step is never inferred.** `askForKey` is told
which one to open on, and only on the way in — most of the ways the gate opens
are a key that stopped working, and walking somebody back through the
explanation is what this replaced. Only the *first* call opens the card: a tile
failure arriving while somebody reads screen one rewrites the notice rather than
yanking the screen away. `keyAccepted` carries a generation so a verification
resolving after a later failure cannot close the new card.

**The interface waits for the tile service, not for the credential checker.**
`verifyTileAuth` passing only says the token is well-formed and the endpoint
knows it; the root tileset can still refuse a moment later. `confirmLiveTileAuth`
answers `ok` / `slow` / `refused`, and only `refused` withholds the interface —
a timeout is not a verdict on the key.

**The notice lives in the footer, outside both steps.** That is what lets a
rejection reach somebody who has wandered back to screen one, and what stops a
step's length pushing the primary below the fold on a phone.

### Recording

**A capture is supervised, not watched, so it keeps its bar.** `is-playing` is
set during a recording too, because the recorder starts the shot through
`playShot`. Left alone that hides the percentage and the only abort control.
`body.is-recording:not(.chrome-hidden) .bar` brings it back.

**Nothing may stop a shot while `world.capturing` is true.** `rig.onChange` and
the canvas pointerdown both call `stopShot`, and a shot stopped mid-capture nulls
`_shot`, after which every `seek` early-returns while the encoder keeps writing
frames. The file saves, reports a size, and has a frozen second half. Both paths
are guarded; any new one must be too.

**Nothing may await between `renderFrame()` and reading the canvas.** A WebGPU
drawing buffer is only readable inside the task that filled it. Measured, not
assumed: read before a render in the same task and the canvas is uniformly zero.

**Tile fades ride the same virtual clock as the move.** `seek()` steps
`TilesFadePlugin` by `1/fps` of real time (`authored / SHOT_RATE`); `settle()`
pumps with `dt` 0 so a wait cannot run the dissolve out. Completing fades per
frame is a pop; leaving them on `performance.now()` is a stutter.

**A zero-sized window invalidates the swapchain permanently.** A collapsed pane
reports `innerWidth` 0; `setSize( 0, 0 )` asks WebGPU for a swapchain texture of
size 0, and every render after that fails validation against the same invalid
view — the canvas is black long after the window has a size again, with no error
after the first. `resize` refuses zero, `init` floors it, and `_tick` reapplies
the size whenever it differs from `_sized`, because a pane collapsed at load
never fires `resize` on its way back. The recorder refuses to start in one: it
would produce a valid file of flat sky.

## Verifying a change

`window.dreamfold` exposes `{ world, ui }`.

**`requestAnimationFrame` is paused in a background tab, and so is the entire
tile pipeline** — `PriorityQueue` schedules its jobs through rAF, so a headless
or unfocused check sits at zero tiles forever and looks like an auth failure. To
drive it anyway, use a MessageChannel, which is not throttled:

```js
const w = dreamfold.world, t = w.tiles
const cb = c => setTimeout( c, 0 )
for ( const n of [ 'downloadQueue', 'parseQueue', 'processNodeQueue', 'lruCache' ] ) t[ n ]._schedulingCallback = cb
const queues = [ 'downloadQueue', 'parseQueue', 'processNodeQueue' ].map( n => t[ n ] )
const ch = new MessageChannel()
ch.port1.onmessage = () => {

	w._tick( performance.now() )
	// the queues were already scheduled against a rAF that will never fire
	for ( const q of queues ) { q.scheduled = false; q.tryRunJobs() }
	ch.port2.postMessage( 0 )

}
ch.port2.postMessage( 0 )
```

After a change to the bend: `world.setBend( 0 )` leaves the city visually
identical to a plain `MeshBasicNodeMaterial` (collapse-onto-the-hinge hides as
"the tiles did not load"); the probe settles within a metre or two of
`groundH + geoidN`; nothing is `NaN` in `world.rig.position`.

After a change to the walk or the centre, walk somewhere with relief — Hong Kong
Central toward the Peak is the one that breaks things:

```js
dispatchEvent( new KeyboardEvent( 'keydown', { code: 'ArrowUp' } ) )
// …a few seconds…
const w = dreamfold.world
console.log( w.groundY, w.rig.x, w.rig.z, w.fold.center.value )
```

Sea level at the waterfront and ~400 m up the hill is right. A `groundY` that
stays at 3 m while the camera climbs is the datum bug, and it shows up as the
folded city curling *under* the viewer instead of over.

To look at one frame of a shot, seek and let the renderer's own loop keep
running. **Do not `world.stop()` first** — WebGPU only presents from the
animation loop, so a stopped loop is a frozen canvas however often you call
`post.render()`, which looks exactly like a black scene:

```js
const w = dreamfold.world
w.stopShot(); w.playShot( 'dream' )
for ( let s = 0; s < 19; s += 1 / 60 ) w._advanceShot( 1 / 60 )
w._shot = null; w.playing = null; w.onShot?.( null )    // hold it there
```

## Style

three.js house style (`eslint-config-mdcs`), enforced by eye rather than by a
linter:

- tabs for indentation
- a space inside every bracket: `foo( a, b )`, `arr[ i ]`, `{ a: 1 }`
- a blank line after an opening `{` of a function/block body, and before the
  closing `}`
- `! value`, not `!value`
- no semicolons
- `_privateMethod` by convention; there are no `#private` fields

Comments explain *why*, and are worth their length when the reason is not
recoverable from the code — most of the ones here document a decision with a
plausible-looking wrong alternative. Do not add comments that restate the line
below them.
