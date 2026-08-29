/**
 * The eight authored dream-training moves.
 *
 * The sliders are the instrument; each of these is one long piece played
 * through them. They start at street level while the city is still ordinary,
 * then let the camera rise as the hinge closes in, the city rolls overhead, and
 * the camera shake grows with it. Every channel stays reachable by hand so the
 * viewer can interrupt a move and keep the frame it left behind.
 *
 * They differ in *what bends and who moves*, not in art direction — haze and
 * aberration are literally shared. `fold` is the film's own move and the one
 * everything else is a variation on: one hinge, a camera that stays put.
 * `gaze` keeps that camera on the pavement and moves only its pitch;
 * `approach` walks into it and `flight` flies at it. `dream` is the film's own
 * *scene*: the same single hinge taken over a thirty-metre crease, so the
 * street ahead folds sharply over and hangs its rooftops just overhead while
 * the world behind stays real. `90degree` stops that same hinge on end — a
 * quarter turn rather than a half, over a hundred and fifty metres of it — so
 * the street ahead never comes over your head: it stands up two streets away
 * as a cliff of city and keeps going straight up. `bowl` swaps the single
 * hinge for a radial one, and `well` is that bowl stopped on end the same way.
 *
 * Shake is a fifth of what it was on the three moves that still have it, and
 * `fold`, `gaze`, `approach`, `dream` and `90degree` have none at all: a shot
 * the viewer is standing still through is not being carried by anything, and
 * a shake with nothing holding the camera is just a wobble. `Rig.apply`
 * squares off the stroke, so the same number reads as a much harder knock
 * than it did when these curves were first written.
 *
 * `short` and `note` are the bar's, not the shot's: `short` is what fits the
 * one-word readout under Animation, and `note` is the line the popover puts
 * under the name — which is the whole reason that control is a list and not a
 * button that cycles.
 *
 * What makes it read as cinema rather than as a slider being dragged is that
 * the channels are *offset* from one another. The bend, crane and hinge all
 * move from the first frame at different rates and the shake reaches its crest
 * just before the camera settles. `responsive` starts gently without looking
 * paused and still arrives with zero velocity.
 *
 * The lens is the one thing none of them touch. Every move used to open it from
 * about seventy degrees to near a hundred on the way through, and eight
 * authored zooms is eight ways to overwrite the focal length the viewer chose:
 * whatever the Lens slider says when a move starts is now what the whole of it
 * is shot on. It is the deliberate exception to authoring every channel — the
 * value being held is the viewer's, so there is nothing to author it *to*. The
 * moves that were framed against the wide end of that ramp, `gaze` above all,
 * want a wider Lens set by hand than the base look's.
 *
 * ## Channels
 *
 *   bend       0…1, turns of the city
 *   foldStart  metres of flat ground in front of the viewer
 *   foldLength metres of ground the half turn is spent over. One number with
 *              `bend` as far as the shader is concerned — the curvature is
 *              their ratio — but `bend` is how far round the city has come and
 *              this is how tight the arc it comes round on is.
 *   curl       degrees of turn the roll is allowed before the rest of the arc
 *              runs on straight along the tangent. Normally a property of the
 *              shape and left alone; `90degree` is the one move that drives it.
 *   dolly      metres forward along the bearing the move opened on
 *   haze       distance band, as a fraction of the loaded disc
 *   aberration chromatic aberration, 0…1
 *   height     metres above the pavement. It is a floor and not a position:
 *              `rig.apply` keeps the lens above whatever it is standing on,
 *              which is why arrival positioning finds pavement before the CTA
 *              becomes available.
 *   pitch      degrees, absolute (positive is up)
 *   drift      high-frequency rotational and positional camera shake
 *
 * A track is a list of `[ time, value ]` or `[ time, value, ease ]`. The ease
 * named on a key is the curve used to arrive *at* that key. `playShot` replaces
 * the first hinge value with the current live hinge, and caps every later key
 * at the farther of that live hinge and the move's own landing value: the
 * approach can only come closer, never snap out to a waypoint on a replay —
 * but a move that opens with the hinge already spent by the previous one may
 * still ease back out to the distance it is authored to end at.
 */

/**
 * How fast authored time is played back, live and into a recording alike.
 *
 * Every track below is written in its own seconds, and this is the one place
 * that decides what those seconds are worth — 1.25 plays the whole set a
 * quarter faster without touching a single key, so the shape of a move and the
 * speed of it stay separate things to tune. `duration` on a shot is authored
 * seconds too, so a 42 there is 33.6 on a clock — divide by this for the
 * wall-clock length of anything, which is what the recorder does to decide how
 * many frames a move is worth.
 */
export const SHOT_RATE = 1.25

const EASE = {
	accelerate: t => t * t,
	// Full speed on the first frame, settling to zero. `responsive` opens at a
	// fifth of linear speed, which over a minute-long bend is ten seconds of
	// nothing anyone can feel; this is for the channel that has to be *seen
	// moving* the moment the move starts, and it still arrives like the others.
	eager: t => 1 - ( 1 - t ) * ( 1 - t ),
	// The one channel that must not settle. Every other curve here arrives
	// somewhere and stops, which is what a camera move does; a cruise does not,
	// and easing the end of `flight`'s dolly puts the brakes on an aircraft.
	linear: t => t,
	responsive: t => ( - 1.8 * t + 2.6 ) * t * t + 0.2 * t,
	smoother: t => t * t * t * ( t * ( t * 6 - 15 ) + 10 ),
}

/**
 * The two channels every move runs identically, hoisted so they cannot drift.
 *
 * `haze` climbs rather than falls: the number scales the distance band, so a
 * bigger one pushes the fog further out and shows more city. It stops just
 * under 1 because past there the rim of the loaded disc stops being hidden at
 * all, which is a hard edge across whatever the fold has put in front of it.
 */
const HAZE_CLEARS = [ [ 0, 0.88 ], [ 34, 1, 'smoother' ] ]

/**
 * Nothing at all until the city is well past vertical, then a lot of it.
 *
 * It tops out at 0.6 and not at 1. The slider goes to 1 because somebody will
 * want it, but by half the frame edges are already fringing hard enough to read
 * as a broken monitor rather than as a lens.
 */
const ABERRATION_GROWS = [ [ 0, 0 ], [ 12, 0.04 ], [ 40, 0.6, 'accelerate' ] ]

/**
 * The house roll length, held.
 *
 * Six of the eight spend their turn over the full reach and have no opinion
 * about it — but they still have to say so, because leaving the channel out
 * leaves the roll wherever the last move or the last drag put it, and the
 * other two crush it: `dream` ends at thirty metres and `90degree` at a
 * hundred and fifty. One key is a constant: `sampleTrack` answers with it at
 * every t.
 */
const ROLL_HOLDS = [ [ 0, 1900 ] ]

/**
 * No shake at all, for the five moves that are not being carried.
 *
 * `flight` is in an aircraft, `bowl` and `well` are having the ground taken out
 * from under them in every direction at once, and those three keep theirs. The
 * other five are a person standing on a pavement — or a fold that arrives on
 * its own — and the stillness is what says so.
 */
const HELD_STILL = [ [ 0, 0 ] ]

/** The film fold rises at sixty per cent of its original speed.
 *
 * Duration, bend, hinge, crane, pitch and haze all divide by this. Leaving
 * the camera on the original forty-two-second clock parked it for the last
 * third of the move — which a capture then wrote as still video after the
 * street had already come over. */
const FOLD_RISE_SPEED = 0.6

/** A gentler fringe that grows in step with the film fold's slower rise. */
const FOLD_ABERRATION_GROWS = [
	[ 0, 0 ],
	[ 12 / FOLD_RISE_SPEED, 0.02 ],
	[ 40 / FOLD_RISE_SPEED, 0.3, 'accelerate' ],
]

/** Haze on the same clock as the slower fold, so it does not clear at half time. */
const FOLD_HAZE_CLEARS = [ [ 0, 0.88 ], [ 34 / FOLD_RISE_SPEED, 1, 'smoother' ] ]

export const SHOTS = [

	{
		id: 'fold',
		name: 'The fold',
		short: 'Fold',
		note: 'The film\u2019s own move: stand still, and the street ahead comes over your head',
		shape: 'fold',
		duration: 42 / FOLD_RISE_SPEED,
		// Opens almost at the top of the move rather than a quarter in, because
		// the eager bend below leaves no establishing stretch to skip: the
		// horizon is already lifting on the first frame. Trimming a quarter
		// away here would open on a fold nearly half spent, which is a picture
		// of a fold rather than the arrival of one.
		start: 0.08,
		tracks: {
			// `eager`, not `responsive`: at nineteen hundred metres of roll the
			// bend has to reach a fifth of a turn before the street can feel it
			// at all, and the gentle open spent ten seconds getting there — a
			// move that starts by not moving. Full speed from the first frame
			// puts the horizon visibly climbing within a second of Start, and
			// the long settle keeps it one continuous, slow fold.
			bend: [ [ 0, 0 ], [ 40 / FOLD_RISE_SPEED, 1, 'eager' ], [ 42 / FOLD_RISE_SPEED, 1 ] ],
			// The rising city advances on the viewer instead of retreating, with
			// the final twenty metres left flat as a sliver of reference ground.
			// The dive to two hundred and forty is `eager` and nearly immediate,
			// because the first value is replaced with the live hinge and the
			// base look leaves that at sixteen hundred metres: any curve that
			// strolls in from there spends its opening on a bend the haze has
			// already swallowed. The street ramping up a couple of hundred
			// metres ahead is what makes the fold felt at once — the bend value
			// alone never is, at this roll length, while the hinge is far.
			// It then holds near two hundred through the middle — the dive is for
			// the opening, and carrying it straight on to twenty would spend the
			// flat reference street by half time, which is the aerial-photograph
			// failure `FOLD_TILT` guards the other end of.
			foldStart: [
				[ 0, 620 ],
				[ 10 / FOLD_RISE_SPEED, 240, 'eager' ],
				[ 30 / FOLD_RISE_SPEED, 190, 'smoother' ],
				[ 41 / FOLD_RISE_SPEED, 20, 'smoother' ],
				[ 42 / FOLD_RISE_SPEED, 20 ],
			],
			// Well clear of the roofline by the end. A crane that stays in the
			// street keeps the near buildings across the bottom third of frame,
			// and the arc is the thing worth having room for.
			height: [ [ 0, 6 ], [ 42 / FOLD_RISE_SPEED, 96, 'responsive' ] ],
			// `foldTilt` supplies another ten degrees by the end, so this remains
			// slightly downward to counter it and hold onto that strip.
			pitch: [
				[ 0, - 3 ],
				[ 8 / FOLD_RISE_SPEED, - 3 ],
				[ 18 / FOLD_RISE_SPEED, - 4, 'smoother' ],
				[ 40 / FOLD_RISE_SPEED, - 9, 'smoother' ],
				[ 42 / FOLD_RISE_SPEED, - 9 ],
			],
			foldLength: ROLL_HOLDS,
			// The air clears as the city closes. Haze exists to hide the rim of
			// the loaded disc, and the fold is what takes that rim off the
			// horizon and puts it overhead — so the further round it goes, the
			// less there is to hide and the further you are allowed to see.
			haze: FOLD_HAZE_CLEARS,
			aberration: FOLD_ABERRATION_GROWS,
			drift: HELD_STILL,
		},
	},

	{
		id: 'gaze',
		name: 'The gaze',
		short: 'Gaze',
		note: 'Stand still and tilt your head back until the city is the ceiling',
		shape: 'fold',
		duration: 38,
		start: 0.25,
		tracks: {
			bend: [ [ 0, 0 ], [ 35, 1, 'responsive' ], [ 38, 1 ] ],
			foldStart: [ [ 0, 700 ], [ 36, 40, 'responsive' ], [ 38, 40 ] ],
			// Authored, and flat. Every other move cranes, and this one is defined
			// by not doing it — but leaving the channel out would not hold the
			// camera down, it would leave it at whatever the height slider was last
			// dragged to. Six metres is a person on the pavement.
			height: [ [ 0, 6 ], [ 38, 6 ] ],
			// The whole move is here. Everywhere else pitch is a correction applied
			// to a crane; this is the only shot where it *is* the shot, so it gets
			// the long eased curve the others give to `bend`.
			//
			// It lands at 48 and not higher because `foldTilt` adds ten of its own
			// by then, and 58 degrees is as far back as the head goes while the last
			// of the flat street is still in the bottom of frame — the only thing
			// left in shot that says the ceiling used to be the ground. Point it
			// further up and that reference goes, and with it the reason any of it
			// reads as strange. How much of it survives is the Lens slider's
			// business now rather than this file's: the move was framed on the
			// hundred-degree end of a ramp that no longer runs, and at the base
			// look's sixty-nine the bottom edge sits well above the street.
			pitch: [ [ 0, - 3 ], [ 6, - 2 ], [ 20, 14, 'smoother' ], [ 36, 48, 'smoother' ], [ 38, 48 ] ],
			foldLength: ROLL_HOLDS,
			haze: HAZE_CLEARS,
			aberration: ABERRATION_GROWS,
			drift: HELD_STILL,
		},
	},

	{
		id: 'approach',
		name: 'The approach',
		short: 'Approach',
		note: 'The same fold, walked into \u2014 the flat street runs under you as the arc arrives',
		shape: 'fold',
		duration: 40,
		start: 0.25,
		tracks: {
			// The one that travels. Everything else here bends the city around a
			// camera that stays put; this one walks into it, so the flat street
			// runs *under* the viewer and the arc arrives rather than grows.
			//
			// The hinge holds much further out than in `fold` for the whole first
			// half, because the dolly is already closing the distance — pulling it
			// in as well would double the rate and land the arc overhead before
			// the walk had got anywhere.
			bend: [ [ 0, 0 ], [ 38, 1, 'responsive' ], [ 40, 1 ] ],
			foldStart: [ [ 0, 900 ], [ 20, 700, 'smoother' ], [ 39, 40, 'responsive' ], [ 40, 40 ] ],
			dolly: [ [ 0, 0 ], [ 40, 1150, 'smoother' ] ],
			height: [ [ 0, 5 ], [ 40, 62, 'responsive' ] ],
			pitch: [ [ 0, - 2 ], [ 12, - 3 ], [ 38, - 8, 'smoother' ], [ 40, - 8 ] ],
			foldLength: ROLL_HOLDS,
			haze: HAZE_CLEARS,
			aberration: ABERRATION_GROWS,
			drift: HELD_STILL,
		},
	},

	{
		id: 'flight',
		name: 'The flight',
		short: 'Flight',
		note: 'Lift off the pavement and fly at the wall the city folds up into',
		shape: 'fold',
		// The shortest of the eight, because it is the only one whose subject is
		// speed. Given the same forty seconds the dolly would either crawl or
		// run out of city.
		duration: 34,
		// One of the two moves that do not open a quarter of the way in — the
		// other is `fold`, whose eager bend leaves nothing to skip. For the
		// remaining five the first stretch is an ordinary street and the curves
		// merely have to come from somewhere; here that stretch *is* the shot's
		// first beat — the lens leaving the pavement — and skipping it opens
		// the move already airborne, which is a different move.
		start: 0.08,
		tracks: {
			bend: [ [ 0, 0 ], [ 30, 1, 'responsive' ], [ 34, 1 ] ],
			// Held closer than any other move and barely pulled in. The hinge does
			// not travel with the dolly — `fold.center` rides the camera, so the arc
			// stays this far ahead however far the flight gets — and that is exactly
			// what is wanted here: a fixed wall of city to fly at, with a hundred
			// and fifty metres of real buildings as the runway up to it.
			foldStart: [ [ 0, 480 ], [ 31, 150, 'responsive' ], [ 34, 150 ] ],
			// Two kilometres, and the only track in this file that ends at speed.
			// A take-off under `accelerate`, then a cruise held `linear` to the last
			// frame — around 80 m/s, which is fast enough to read as flight and slow
			// enough that the near façades blur past rather than strobe.
			dolly: [ [ 0, 0 ], [ 13, 300, 'accelerate' ], [ 34, 2050, 'linear' ] ],
			// Climbs with the dolly and keeps climbing. `height` is a floor rather
			// than a position, so this is what the flight *clears*, not where it
			// sits: crossing a tower puts the lens on its roof for as long as the
			// roof is under it, and that skim is most of what sells the altitude.
			height: [ [ 0, 4 ], [ 13, 44, 'accelerate' ], [ 34, 170, 'linear' ] ],
			// The one move that ends looking up. It can, because by then the fold is
			// closed and up is city rather than sky — and `foldTilt` adds ten degrees
			// on top of this, so the lens finishes about thirteen degrees above level
			// with the underside of the arc filling the top of frame and the street
			// still running out of the bottom of it.
			pitch: [ [ 0, - 2 ], [ 9, - 5, 'smoother' ], [ 24, - 4, 'smoother' ], [ 32, 3, 'smoother' ], [ 34, 3 ] ],
			haze: HAZE_CLEARS,
			aberration: ABERRATION_GROWS,
			// Unlike the others this starts with something already in it and steps
			// up at the take-off. The rest of the file uses shake to say the city
			// is becoming impossible; here it is also saying the camera is a thing
			// being flown.
			foldLength: ROLL_HOLDS,
			drift: [ [ 0, 0.06 ], [ 13, 0.34, 'accelerate' ], [ 33, 1, 'accelerate' ], [ 34, 1 ] ],
		},
	},

	{
		id: 'dream',
		name: 'The dream',
		short: 'Dream',
		note: 'Rue C\u00e9sar Franck: the street ahead folds clean over and hangs its rooftops above your head',
		shape: 'dream',
		duration: 44,
		start: 0.25,
		tracks: {
			// Full commitment — the stopping-short lives in the shape's curl,
			// not here. Bending less would only slacken the crease; the curl is
			// what decides the folded street never flattens into a lid over the
			// lens.
			bend: [ [ 0, 0 ], [ 40, 1, 'responsive' ], [ 44, 1 ] ],
			// The crease ends a hundred and ten metres out. Closer and the roll
			// happens on top of the viewer; further and the hanging street is a
			// backdrop rather than a ceiling. Most of the approach is spent in
			// the first half of the move, so what stands up is the near street
			// and not a horizon.
			foldStart: [ [ 0, 520 ], [ 22, 150, 'responsive' ], [ 43, 110, 'smoother' ], [ 44, 110 ] ],
			// Thirty metres of ground for the roll, against the nineteen
			// hundred every other move uses — a crease of radius ten, the
			// sharpest in the file. The street does not lift toward a horizon,
			// it folds over like paper: rooftops brush the ground at the crease
			// and climb to hang a street's height over your shoulder. The
			// tightening comes almost at once rather than at the end — held at
			// the house length the early bend is a kilometres-wide arc that
			// reads as a distant swell rolling in, and this move is the fold
			// arriving *here*, fast.
			foldLength: [ [ 0, 1900 ], [ 14, 90, 'responsive' ], [ 43, 30, 'smoother' ], [ 44, 30 ] ],
			// It barely cranes at all, and that is the whole shot: the film's
			// framing is two people on a pavement under a folded street. It
			// also cannot climb — the ceiling is at nineteen metres where the
			// crease turns over, and the hanging rooflines come down to head
			// height there.
			height: [ [ 0, 4 ], [ 44, 6, 'responsive' ] ],
			// Ends level, which is ten degrees up: `foldTilt` supplies all of
			// them by full bend, and that is already as far back as the head can
			// go while the road is still in the bottom of the frame.
			pitch: [ [ 0, - 2 ], [ 9, - 2 ], [ 26, - 1, 'smoother' ], [ 41, 0, 'smoother' ], [ 44, 0 ] ],
			haze: HAZE_CLEARS,
			aberration: ABERRATION_GROWS,
			drift: HELD_STILL,
		},
	},

	{
		id: '90degree',
		name: 'Ninety degrees',
		short: '90\u00b0',
		note: 'A quarter turn instead of a half \u2014 the street ahead stands on end, and nothing comes over your head',
		shape: 'fold',
		duration: 40,
		start: 0.25,
		tracks: {
			bend: [ [ 0, 0 ], [ 36, 1, 'responsive' ], [ 40, 1 ] ],
			// The one move that authors its own curl instead of taking the
			// shape's. A curl usually lives on a shape — `tube` is the bowl
			// stopped at a quarter turn — but this is the plain `fold` hinge
			// stopped at that same place, and a sixth row in the shape picker is
			// a heavier thing to add than a channel `_applyChannel` already
			// drives. Held flat, because the quarter turn is what the move *is*:
			// a curl easing open would be a wall unfolding rather than one being
			// built. What moves instead is `bend` and the roll length below, and
			// between them they tighten the arc and walk the standing city in.
			curl: [ [ 0, 90 ] ],
			// Where the wall stands. Two hundred and forty metres of flat road,
			// then the crease — and on a hundred and fifty metre roll the standing
			// face ends up about fifty metres past it, so the cliff is a couple of
			// streets away rather than on the horizon and there is still enough
			// road in front of it to read as road. It arrives late and unhurried:
			// the roll length below is already doing the work of standing the city
			// up, so there is nothing here for a dive to rescue.
			foldStart: [ [ 0, 700 ], [ 22, 380, 'responsive' ], [ 38, 240, 'smoother' ], [ 40, 240 ] ],
			// A hundred and fifty metres of ground for the quarter turn, where six
			// of the eight spend theirs over the full nineteen hundred. That is a
			// radius of forty-eight: the road turns through the whole ninety
			// degrees within seventy-five metres of the crease, and every metre of
			// city past that runs on *vertically*. What stands at the end of the
			// street is not a slope but a cliff face of it, going up out of frame
			// with its buildings pointing sideways at you. It tightens early for
			// `dream`'s reason: held at the house length the early bend is a
			// kilometres-wide arc that reads as a swell somewhere else, and this
			// move is the wall arriving here.
			foldLength: [ [ 0, 1900 ], [ 16, 400, 'responsive' ], [ 38, 150, 'smoother' ], [ 40, 150 ] ],
			// Barely a crane, because the roll is short: the turning part of the
			// face is only forty-eight metres tall before the run-on takes over,
			// and a camera that climbed would be looking *down* onto the crease —
			// a wall read from level with its top is not a wall. Twenty-eight is
			// enough to see the flat road over the near rooftops and no more.
			height: [ [ 0, 5 ], [ 40, 28, 'responsive' ] ],
			// Ends fourteen degrees up, which is twenty-four once `foldTilt` has
			// added its ten: a head tilted back at something standing close by,
			// rather than the glance along a street the long rolls ask for. The
			// city stays clear to about sixty-five degrees and hazes out by
			// eighty, and the crease still sits five degrees *below* the lens at
			// any focal length worth watching this on: the flat road is what says
			// the cliff is a road too.
			pitch: [ [ 0, - 3 ], [ 10, - 3 ], [ 26, 4, 'smoother' ], [ 38, 14, 'smoother' ], [ 40, 14 ] ],
			haze: HAZE_CLEARS,
			aberration: ABERRATION_GROWS,
			drift: HELD_STILL,
		},
	},

	{
		id: 'bowl',
		name: 'The bowl',
		short: 'Bowl',
		note: 'Every direction hinges at once and the city closes into a dish around you',
		shape: 'bowl',
		duration: 38,
		start: 0.25,
		tracks: {
			// Every direction hinges at once, so there is no flat street left to
			// stand on — only the dish under your feet. It stops short of closed:
			// a dome that meets over the lens leaves no rim in frame, and the rim
			// is the only thing that says the ceiling used to be the ground.
			bend: [ [ 0, 0 ], [ 34, 0.92, 'responsive' ], [ 38, 0.92 ] ],
			foldStart: [ [ 0, 780 ], [ 37, 120, 'responsive' ], [ 38, 120 ] ],
			// The highest of the eight. A bowl read from inside the bowl is a
			// wall; the climb is what turns it back into a shape.
			height: [ [ 0, 8 ], [ 38, 190, 'responsive' ] ],
			pitch: [ [ 0, - 4 ], [ 14, - 2 ], [ 36, - 12, 'smoother' ], [ 38, - 12 ] ],
			haze: HAZE_CLEARS,
			aberration: ABERRATION_GROWS,
			foldLength: ROLL_HOLDS,
			drift: [ [ 0, 0.02 ], [ 37, 0.92, 'accelerate' ], [ 38, 0.92 ] ],
		},
	},

	{
		id: 'well',
		name: 'The well',
		short: 'Well',
		note: 'The bowl stopped at a quarter turn: the city stands up into a shaft',
		shape: 'tube',
		duration: 40,
		start: 0.25,
		tracks: {
			// The bowl stopped at a quarter turn, which is a shaft with no
			// ceiling. The lens has to stay off the opening — a tube has nothing
			// up there by construction, and pointed at it the shot finds the one
			// part of the scene that is empty.
			bend: [ [ 0, 0 ], [ 36, 1, 'responsive' ], [ 40, 1 ] ],
			foldStart: [ [ 0, 700 ], [ 39, 60, 'responsive' ], [ 40, 60 ] ],
			height: [ [ 0, 5 ], [ 40, 120, 'responsive' ] ],
			pitch: [ [ 0, - 3 ], [ 16, - 6 ], [ 38, - 14, 'smoother' ], [ 40, - 14 ] ],
			haze: HAZE_CLEARS,
			aberration: ABERRATION_GROWS,
			foldLength: ROLL_HOLDS,
			drift: [ [ 0, 0.03 ], [ 39, 1, 'accelerate' ], [ 40, 1 ] ],
		},
	},

]

/** What the picker opens on, and what a caller with no opinion gets. */
export const DEFAULT_SHOT = SHOTS[ 0 ].id

export const SHOT_MAP = new Map( SHOTS.map( s => [ s.id, s ] ) )

/**
 * Value of a track at time `t`, held flat outside its own range.
 *
 * Held rather than extrapolated on purpose: a track that finishes before the
 * shot does is a channel that has settled, not one that should keep going.
 */
export function sampleTrack( keys, t ) {

	if ( ! keys || keys.length === 0 ) return null
	if ( t <= keys[ 0 ][ 0 ] ) return keys[ 0 ][ 1 ]

	for ( let i = 1; i < keys.length; i ++ ) {

		const [ time, value, ease ] = keys[ i ]
		if ( t > time ) continue

		const [ prevTime, prevValue ] = keys[ i - 1 ]
		const span = time - prevTime
		const k = span > 0 ? ( t - prevTime ) / span : 1
		const curve = EASE[ ease ] || EASE.smoother
		return prevValue + ( value - prevValue ) * curve( k )

	}

	return keys[ keys.length - 1 ][ 1 ]

}

/**
 * Authored time at which every moving channel has arrived, ignoring look
 * (haze, aberration) and any trailing hold keys that repeat the landing value.
 *
 * Shot `duration` is often a couple of seconds past that arrival so a live
 * move can rest on the last frame. A capture that used duration anyway encoded
 * those still seconds as real video — dozens of frames of a picture that has
 * already stopped changing. Live Start stops here too, so the file and the
 * screen are the same length.
 */
export function lastMotionTime( tracks, duration ) {

	let end = 0
	let moving = false

	for ( const name in tracks ) {

		if ( name === 'haze' || name === 'aberration' ) continue
		const keys = tracks[ name ]
		if ( ! keys || keys.length === 0 ) continue

		const final = sampleTrack( keys, duration )
		let arrive = 0
		let changed = false

		for ( let i = 0; i < keys.length; i ++ ) {

			const t = keys[ i ][ 0 ]
			if ( t > duration ) break
			if ( Math.abs( keys[ i ][ 1 ] - final ) > 1e-6 ) {

				changed = true
				const next = i + 1 < keys.length ? keys[ i + 1 ][ 0 ] : duration
				arrive = Math.min( next, duration )

			}

		}

		if ( ! changed ) continue
		moving = true
		end = Math.max( end, arrive )

	}

	return moving ? end : duration

}
