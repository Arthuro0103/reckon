// reckon-pet: the lantern, drawn natively, sitting above everything including full-screen apps.
//
// This is the one native file in reckon (CONTRIBUTING.md section 2). `reckon watch --pet` compiles it
// on this machine with `swiftc` the first time, and starts it as a child of the watcher.
//
// What it does:   reads ~/.cache/reckon/watch.json, draws the lantern, shows a card when clicked.
// What it never does: start another program, open an address, reach the network, run the command
//                 shown on the card (it shows it as text and offers a copy button), or delete a file.
// What it writes: ~/.cache/reckon/pet.json (where you left it), and nothing else.
//
// The lantern's numbers come from `pose(level)` in web/pet.js. `poseOf` below is the same function,
// and `--dump-pose` prints it so bin/check.js can compare the two. The paths are the same strings.
//
//   reckon-pet                    run (what the watcher does)
//   reckon-pet --level 0.9        show a fixed level instead of reading watch.json (to look at it)
//   reckon-pet --dump-pose        print pose() at 101 levels as JSON, and exit
//   reckon-pet --selfcheck        show the window, ask the window server where it really is, and exit

import AppKit

// ---------------------------------------------------------------------------
// Colours: web/tokens.css, the same hex values.
// ---------------------------------------------------------------------------
func hex(_ v: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}
let cBg2 = hex(0x0b1a26), cBg3 = hex(0x122432), cInk = hex(0xe4f0f5), cInk2 = hex(0x9db3c1), cInk3 = hex(0x718c9b)
let cLine2 = hex(0x24455a), cCyan = hex(0x3ddbf0), cS4 = hex(0xab9022), cS2 = hex(0xcc6f28)

func glowColor(_ name: String?) -> NSColor? {
    switch name {
    case "var(--cyan)": return cCyan
    case "var(--s4)": return cS4
    case "var(--s2)": return cS2
    default: return nil
    }
}

// color-mix(in srgb, a, b pct%)
func mix(_ a: NSColor, _ b: NSColor, _ pct: Double) -> NSColor {
    let x = a.usingColorSpace(.sRGB)!, y = b.usingColorSpace(.sRGB)!
    let t = CGFloat(pct / 100)
    return NSColor(srgbRed: x.redComponent * (1 - t) + y.redComponent * t,
                   green: x.greenComponent * (1 - t) + y.greenComponent * t,
                   blue: x.blueComponent * (1 - t) + y.blueComponent * t, alpha: 1)
}

// ---------------------------------------------------------------------------
// pose(level): the lantern as numbers. Mirrors STATES, resolve and pose in web/pet.js.
// ---------------------------------------------------------------------------
struct Base { let open: Double, brow: Double, mouth: Double, shake: Double, drop: Double; let glow: String? }
let STATES: [String: Base] = [
    "resting":  Base(open: 0.10, brow: 0,  mouth: -1, shake: 0, drop: 0, glow: nil),
    "watching": Base(open: 0.75, brow: 0,  mouth: -2, shake: 0, drop: 0, glow: "var(--cyan)"),
    "uneasy":   Base(open: 0.85, brow: 16, mouth: 2,  shake: 0, drop: 0, glow: "var(--s4)"),
    "strained": Base(open: 1.00, brow: 24, mouth: 5,  shake: 3, drop: 1, glow: "var(--s2)"),
]
func stateName(_ l: Double) -> String { l < 0.15 ? "resting" : l < 0.45 ? "watching" : l < 0.8 ? "uneasy" : "strained" }
func kindOf(_ l: Double) -> Int { l < 0.15 ? 0 : l < 0.45 ? 1 : l < 0.8 ? 2 : 3 }

struct Pose {
    var level, heat, lit, open, drop, shake, brow, mouth, pupil, glowMix, haloOpacity, glassOpacity: Double
    var flameH, flameW, coreOpacity, rays, rayGap, rayLen, secondDrop: Double
    var sway, swingT, flickT, pulseT, shakePx, shakeT: Double
    var glow: String?

    // The numbers, keyed as web/pet.js keys them, for --dump-pose.
    var json: [String: Any] {
        var d: [String: Any] = [
            "level": level, "heat": heat, "lit": lit, "open": open, "drop": drop, "shake": shake, "brow": brow, "mouth": mouth,
            "pupil": pupil, "glowMix": glowMix, "haloOpacity": haloOpacity, "glassOpacity": glassOpacity, "flameH": flameH,
            "flameW": flameW, "coreOpacity": coreOpacity, "rays": rays, "rayGap": rayGap, "rayLen": rayLen,
            "secondDrop": secondDrop, "sway": sway, "swingT": swingT, "flickT": flickT, "pulseT": pulseT,
            "shakePx": shakePx, "shakeT": shakeT,
        ]
        d["glow"] = glow ?? NSNull()
        return d
    }
}

func poseOf(_ input: Double) -> Pose {
    let l = max(0, min(1, input))
    let b = STATES[stateName(l)]!
    let heat = max(0, min(1, (l - 0.8) / 0.2))
    let lit = min(1, 0.25 + l * 0.75)
    let rays: Double = l > 0.8 ? 4 + (heat * 3).rounded(.toNearestOrAwayFromZero) : (l * 5).rounded(.toNearestOrAwayFromZero)
    let sway = l < 0.8 ? 0.8 + l * 1.6 : 2.08 - min(1, heat * 2) * 1.08
    return Pose(
        level: l, heat: heat, lit: lit, open: b.open, drop: b.drop, shake: b.shake,
        brow: b.brow + heat * 8, mouth: b.mouth + heat * 3, pupil: 3 - heat * 1.2,
        glowMix: heat * 50, haloOpacity: 0.10 + l * 0.32 + heat * 0.22,
        glassOpacity: min(0.95, 0.30 + lit * 0.55 + heat * 0.10),
        flameH: 5 + l * 10, flameW: 0.55 + heat * 0.4, coreOpacity: heat * 0.9,
        rays: rays, rayGap: rays > 5 ? 8.5 : 10, rayLen: 6 + l * 8 + heat * 4, secondDrop: heat > 0.5 ? 1 : 0,
        sway: sway, swingT: 4.6 - l * 3.2, flickT: 1.7 - l * 1.2, pulseT: 3.4 - l * 2.5,
        shakePx: 0.5 + heat * 2.2, shakeT: 0.14 - heat * 0.07, glow: b.glow)
}

if CommandLine.arguments.contains("--dump-pose") {
    let all = (0...100).map { poseOf(Double($0) / 100).json }
    let data = try! JSONSerialization.data(withJSONObject: all, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
}

// ---------------------------------------------------------------------------
// The drawing. Everything is measured in the same 120 x 120 box as web/pet.js, with y pointing
// DOWN there; CoreAnimation points y UP, so every point goes through P().
// ---------------------------------------------------------------------------
let BOX: CGFloat = 120
func P(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: Double(BOX) - y) }

// The same path strings as web/pet.js, read by a parser that knows only M L H V Q Z, absolute.
func svgPath(_ d: String) -> CGPath {
    var tokens: [String] = [], cur = ""
    for ch in d {
        if "MLHVQZ".contains(ch) { if !cur.isEmpty { tokens.append(cur); cur = "" }; tokens.append(String(ch)) }
        else if ch == " " || ch == "," { if !cur.isEmpty { tokens.append(cur); cur = "" } }
        else { cur.append(ch) }
    }
    if !cur.isEmpty { tokens.append(cur) }
    let path = CGMutablePath()
    var i = 0, x = 0.0, y = 0.0
    func num() -> Double { defer { i += 1 }; return Double(tokens[i]) ?? 0 }
    while i < tokens.count {
        let c = tokens[i]; i += 1
        switch c {
        case "M": x = num(); y = num(); path.move(to: P(x, y))
        case "L": x = num(); y = num(); path.addLine(to: P(x, y))
        case "H": x = num(); path.addLine(to: P(x, y))
        case "V": y = num(); path.addLine(to: P(x, y))
        case "Q": let cx = num(), cy = num(); x = num(); y = num(); path.addQuadCurve(to: P(x, y), control: P(cx, cy))
        case "Z": path.closeSubpath()
        default: break
        }
    }
    return path
}

let BODY_D = "M38 46 Q31 76 37 106 H83 Q89 76 82 46 Z"
let ROOF_D = "M34 46 L46 32 H74 L86 46 Z"
let STEM_D = "M60 27 V32"
let BASE_D = "M30 110 H90"

var drawScale: CGFloat = 3   // pixels per box unit, so strokes stay sharp

func shape(_ path: CGPath, fill: NSColor? = nil, stroke: NSColor? = nil, width: CGFloat = 0, opacity: Float = 1) -> CAShapeLayer {
    let l = CAShapeLayer()
    l.frame = CGRect(x: 0, y: 0, width: BOX, height: BOX)
    l.path = path
    l.fillColor = fill?.cgColor
    l.strokeColor = stroke?.cgColor
    l.lineWidth = width
    l.lineCap = .round
    l.lineJoin = .round
    l.opacity = opacity
    l.contentsScale = drawScale
    return l
}
func stroked(_ d: CGPath, _ color: NSColor, _ w: CGFloat) -> CAShapeLayer { shape(d, stroke: color, width: w) }
func segment(_ a: CGPoint, _ b: CGPoint) -> CGPath { let p = CGMutablePath(); p.move(to: a); p.addLine(to: b); return p }
func quad(_ a: CGPoint, _ c: CGPoint, _ b: CGPoint) -> CGPath { let p = CGMutablePath(); p.move(to: a); p.addQuadCurve(to: b, control: c); return p }

// A layer whose animations turn about (ox, oy), measured in the box (y down).
func group(_ ox: Double, _ oy: Double) -> CALayer {
    let g = CALayer()
    g.bounds = CGRect(x: 0, y: 0, width: BOX, height: BOX)
    g.anchorPoint = CGPoint(x: ox / Double(BOX), y: (Double(BOX) - oy) / Double(BOX))
    g.position = P(ox, oy)
    return g
}

// A radial glow centred at (cx, cy) with radius r, as a full-box gradient so it needs no offset.
func radial(_ cx: Double, _ cy: Double, _ r: Double, _ colors: [NSColor], _ locations: [Double]) -> CAGradientLayer {
    let g = CAGradientLayer()
    g.frame = CGRect(x: 0, y: 0, width: BOX, height: BOX)
    g.type = .radial
    g.startPoint = CGPoint(x: cx / Double(BOX), y: (Double(BOX) - cy) / Double(BOX))
    g.endPoint = CGPoint(x: (cx + r) / Double(BOX), y: (Double(BOX) - cy + r) / Double(BOX))
    g.colors = colors.map { $0.cgColor }
    g.locations = locations.map { NSNumber(value: $0) }
    return g
}

func eyeLayers(_ cx: Double, _ cy: Double, _ q: Pose, _ rx: Double = 7) -> [CALayer] {
    if q.open < 0.2 { return [stroked(quad(P(cx - rx, cy), P(cx, cy + 4), P(cx + rx, cy)), cCyan, 4)] }
    let ry = 3 + 8 * q.open
    let ring = CGPath(ellipseIn: CGRect(x: cx - rx, y: Double(BOX) - cy - ry, width: 2 * rx, height: 2 * ry), transform: nil)
    let py = cy + (q.open > 0.9 ? 0 : 1)
    let r = q.pupil != 0 ? q.pupil : 3
    let pupil = CGPath(ellipseIn: CGRect(x: cx - r, y: Double(BOX) - py - r, width: 2 * r, height: 2 * r), transform: nil)
    return [stroked(ring, cCyan, 4), shape(pupil, fill: cCyan)]
}

func browLayers(_ cxL: Double, _ cxR: Double, _ y: Double, _ q: Pose, _ half: Double = 7) -> [CALayer] {
    if q.brow == 0 { return [] }
    let dy = sin(q.brow * Double.pi / 180) * half
    return [stroked(segment(P(cxL - half, y + dy), P(cxL + half, y - dy)), cCyan, 4),
            stroked(segment(P(cxR - half, y - dy), P(cxR + half, y + dy)), cCyan, 4)]
}

func dropLayer(_ x: Double, _ y: Double) -> CALayer {
    let p = CGMutablePath()
    p.move(to: P(x, y)); p.addQuadCurve(to: P(x, y + 16), control: P(x + 7, y + 11))
    p.addQuadCurve(to: P(x, y), control: P(x - 7, y + 11)); p.closeSubpath()
    return stroked(p, cCyan, 3)
}

// --- motion -----------------------------------------------------------------------------------
func basic(_ key: String, _ from: Any, _ to: Any, _ dur: Double, reverse: Bool = true,
           ease: CAMediaTimingFunctionName = .easeInEaseOut) -> CABasicAnimation {
    let a = CABasicAnimation(keyPath: key)
    a.fromValue = from; a.toValue = to; a.duration = dur
    a.autoreverses = reverse; a.repeatCount = .infinity
    a.timingFunction = CAMediaTimingFunction(name: ease)
    return a
}
func keyed(_ key: String, _ values: [Any], _ times: [Double], _ dur: Double, reverse: Bool = false) -> CAKeyframeAnimation {
    let a = CAKeyframeAnimation(keyPath: key)
    a.values = values; a.keyTimes = times.map { NSNumber(value: $0) }; a.duration = dur
    a.autoreverses = reverse; a.repeatCount = .infinity
    return a
}
func skewScale(_ sx: CGFloat, _ sy: CGFloat, _ skewDeg: Double) -> NSValue {
    var t = CATransform3DIdentity
    t.m11 = sx; t.m22 = sy; t.m21 = CGFloat(-tan(skewDeg * Double.pi / 180))
    return NSValue(caTransform3D: t)
}

// Builds the whole lantern for one pose. `animate` is false under Reduce Motion: the FORM stays
// (rays, eyes, drop), the movement goes, so nothing is lost but the wobble.
func buildLantern(_ q: Pose, animate: Bool, wake: Bool) -> CALayer {
    let heat = q.heat
    let glowBase = glowColor(q.glow)
    let glow: NSColor? = glowBase.map { heat > 0 ? mix($0, cInk, (q.glowMix).rounded(.toNearestOrAwayFromZero)) : $0 }
    let asleep = q.level < 0.15, strain = q.level > 0.8

    let pop = group(60, 66)
    // The halo is outside the swing: light does not hang from the ring.
    var haloGroup: CALayer? = nil
    if let g = glow {
        let hg = group(60, 66)
        let a = CGFloat(q.haloOpacity)
        hg.addSublayer(radial(60, 66, 52, [g.withAlphaComponent(a), g.withAlphaComponent(a), g.withAlphaComponent(0)], [0, 0.35, 1]))
        if animate {
            hg.add(basic("opacity", 0.7, 1.0, q.pulseT / 2), forKey: "breatheO")
            hg.add(basic("transform.scale", 0.96, 1.05, q.pulseT / 2), forKey: "breatheS")
        }
        haloGroup = hg
        pop.addSublayer(hg)
    }

    let swing = group(asleep ? 60 : 60, asleep ? 110 : 13)
    let shake = group(60, 60)
    swing.addSublayer(shake)
    pop.addSublayer(swing)

    // rays, in pairs
    if q.rays > 0 {
        let lg = group(60, 60), rg = group(60, 60)
        let ray = glow ?? cCyan
        for i in 0..<Int(q.rays) {
            let y = 56 + Double(i) * q.rayGap - (q.rays - 1) * 2
            lg.addSublayer(stroked(segment(P(24, y), P(24 - q.rayLen, y - 3)), ray, 3))
            rg.addSublayer(stroked(segment(P(96, y), P(96 + q.rayLen, y - 3)), ray, 3))
        }
        if animate {
            for (g, dx) in [(lg, -5.0), (rg, 5.0)] {
                g.add(basic("transform.translation.x", 0, dx, q.pulseT, reverse: false, ease: .easeOut), forKey: "ray")
                g.add(basic("opacity", 1.0, 0.25, q.pulseT, reverse: false, ease: .easeOut), forKey: "rayO")
            }
        }
        shake.addSublayer(lg); shake.addSublayer(rg)
    }

    // body: face colour, the glass filled with light, the outline
    let body = svgPath(BODY_D)
    shake.addSublayer(shape(body, fill: cBg2))
    if let g = glow {
        let glass = radial(60, 66, 34, [g.withAlphaComponent(CGFloat(q.glassOpacity)), g.withAlphaComponent(0.06)], [0, 1])
        glass.mask = shape(body, fill: .white)
        shake.addSublayer(glass)
    }
    shake.addSublayer(stroked(body, cCyan, 5))

    // the flame: unlit it is one small dot
    if let g = glow {
        let fg = group(60, 62)
        func flame(_ k: Double) -> CGPath {
            let h = q.flameH, w = q.flameW, p = CGMutablePath()
            p.move(to: P(60, 62 - h * k))
            p.addQuadCurve(to: P(60, 62), control: P(60 + h * w * k, 62 - h * 0.35 * k))
            p.addQuadCurve(to: P(60, 62 - h * k), control: P(60 - h * w * k, 62 - h * 0.35 * k))
            p.closeSubpath()
            return p
        }
        fg.addSublayer(shape(flame(1), fill: g, stroke: g, width: 2, opacity: 0.95))
        if heat > 0 { fg.addSublayer(shape(flame(0.55), fill: cInk, opacity: Float(q.coreOpacity))) }
        if animate {
            let a = keyed("transform", [skewScale(1, 1, 0), skewScale(0.9, 1.14, 5), skewScale(1.07, 0.9, -5)], [0, 0.5, 1], q.flickT, reverse: true)
            a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            fg.add(a, forKey: "flicker")
        }
        shake.addSublayer(fg)
    } else {
        let dot = CGPath(ellipseIn: CGRect(x: 60 - 1.8, y: Double(BOX) - 60 - 1.8, width: 3.6, height: 3.6), transform: nil)
        shake.addSublayer(shape(dot, fill: cCyan, opacity: 0.45))
    }

    shake.addSublayer(stroked(svgPath(ROOF_D), cCyan, 5))
    let ring = CGPath(ellipseIn: CGRect(x: 53, y: Double(BOX) - 20 - 7, width: 14, height: 14), transform: nil)
    shake.addSublayer(stroked(ring, cCyan, 4))
    shake.addSublayer(stroked(svgPath(STEM_D), cCyan, 4))
    shake.addSublayer(stroked(svgPath(BASE_D), cCyan, 6))

    // face
    let eyes = group(60, 80)
    for l in browLayers(50, 70, 70, q, 6) + eyeLayers(50, 80, q) + eyeLayers(70, 80, q) { eyes.addSublayer(l) }
    if animate && !asleep && !strain {
        eyes.add(keyed("transform.scale.y", [1, 1, 0.08, 1], [0, 0.9, 0.94, 1], 4.6), forKey: "blink")
    }
    shake.addSublayer(eyes)
    shake.addSublayer(stroked(quad(P(53, 100), P(60, 100 - q.mouth * 2.2), P(67, 100)), cCyan, 4))

    // sweat
    if q.drop != 0 {
        for (x, delay, show) in [(92.0, 0.0, true), (26.0, 0.75, q.secondDrop != 0)] where show {
            let g = group(60, 60)
            g.addSublayer(dropLayer(x, 26))
            if animate {
                let fall = basic("transform.translation.y", 0, -24, 1.5, reverse: false, ease: .easeIn)
                let fade = keyed("opacity", [0, 1, 0], [0, 0.2, 1], 1.5)
                for a in [fall, fade] { a.beginTime = CACurrentMediaTime() + delay; a.fillMode = .backwards }
                g.add(fall, forKey: "fall"); g.add(fade, forKey: "fade")
            }
            shake.addSublayer(g)
        }
    }

    if animate {
        if asleep {
            swing.add(basic("transform.scale", 1.0, 1.02, 1.9), forKey: "breathe")
        } else {
            swing.add(basic("transform.rotation.z", -q.sway * Double.pi / 180, q.sway * Double.pi / 180, q.swingT / 2), forKey: "sway")
        }
        if strain {
            let s = q.shakePx
            // Two steps per cycle, as `steps(1, end)` does in web/pet.js: +s, then -s.
            let ax = keyed("transform.translation.x", [s, -s], [0, 0.5, 1], q.shakeT)
            let ay = keyed("transform.translation.y", [0, -0.4 * s], [0, 0.5, 1], q.shakeT)
            for a in [ax, ay] { a.calculationMode = .discrete; shake.add(a, forKey: "shake." + a.keyPath!) }
        }
        if wake {
            let grow = CABasicAnimation(keyPath: "transform.scale"); grow.fromValue = 0.82; grow.toValue = 1
            let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0.4; fade.toValue = 1
            for a in [grow, fade] { a.duration = 0.6; a.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 1.5, 0.5, 1) }
            pop.add(grow, forKey: "wakeS"); pop.add(fade, forKey: "wakeO")
        }
    }
    _ = haloGroup
    return pop
}

// ---------------------------------------------------------------------------
// The window.
// ---------------------------------------------------------------------------
let PET: CGFloat = 100                       // panel side, points
let K: CGFloat = PET / BOX                   // box units to points
let CACHE = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/reckon")

func configure(_ p: NSPanel) {
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
    p.level = .screenSaver
    p.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications, .fullScreenAuxiliary, .stationary]
    p.isReleasedWhenClosed = false
}

final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class PetView: NSView {
    weak var app: App?
    var downAt = NSPoint.zero, originAt = NSPoint.zero, dragging = false
    override var isFlipped: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) { downAt = NSEvent.mouseLocation; originAt = window!.frame.origin; dragging = false }
    override func mouseDragged(with e: NSEvent) {
        let now = NSEvent.mouseLocation
        let dx = now.x - downAt.x, dy = now.y - downAt.y
        if !dragging && hypot(dx, dy) < 3 { return }
        dragging = true
        window?.setFrameOrigin(NSPoint(x: originAt.x + dx, y: originAt.y + dy))
        app?.cardFollows()
    }
    override func mouseUp(with e: NSEvent) { if dragging { app?.savePosition() } else { app?.toggleCard() } }
    override func rightMouseDown(with e: NSEvent) { if let m = app?.menu { NSMenu.popUpContextMenu(m, with: e, for: self) } }
}

// ---------------------------------------------------------------------------
// The card: what the headline says, the command AS TEXT, and a button that copies it.
// ---------------------------------------------------------------------------
final class Card {
    let panel: NSPanel
    let title = NSTextField(wrappingLabelWithString: ""), cost = NSTextField(wrappingLabelWithString: ""), foot = NSTextField(wrappingLabelWithString: "")
    let cmd = NSTextField(wrappingLabelWithString: ""), button = NSButton(title: "copy the command", target: nil, action: nil)
    let cmdBox = NSView()
    let stack = NSStackView()
    var closeTimer: Timer?
    var command = ""

    init(target: AnyObject, copy: Selector) {
        panel = PetPanel(contentRect: NSRect(x: 0, y: 0, width: 260, height: 200), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        configure(panel)
        let content = NSView(frame: panel.contentRect(forFrameRect: panel.frame))
        content.wantsLayer = true
        content.layer?.backgroundColor = cBg2.cgColor
        content.layer?.cornerRadius = 10
        content.layer?.borderWidth = 1
        content.layer?.borderColor = cLine2.cgColor
        panel.contentView = content

        func style(_ f: NSTextField, _ font: NSFont, _ color: NSColor, _ align: NSTextAlignment = .center) {
            f.font = font; f.textColor = color; f.alignment = align; f.isSelectable = false
            f.preferredMaxLayoutWidth = 232
        }
        style(title, .systemFont(ofSize: 13, weight: .semibold), cInk)
        style(cost, .systemFont(ofSize: 12), cInk2)
        style(foot, .systemFont(ofSize: 11), cInk3)
        style(cmd, .monospacedSystemFont(ofSize: 11, weight: .regular), cInk, .left)
        cmd.maximumNumberOfLines = 4; cost.maximumNumberOfLines = 5
        cmd.translatesAutoresizingMaskIntoConstraints = false
        cmdBox.wantsLayer = true
        cmdBox.layer?.backgroundColor = cBg3.cgColor
        cmdBox.layer?.cornerRadius = 6
        cmdBox.layer?.borderWidth = 1
        cmdBox.layer?.borderColor = cLine2.cgColor
        cmdBox.addSubview(cmd)
        NSLayoutConstraint.activate([
            cmd.leadingAnchor.constraint(equalTo: cmdBox.leadingAnchor, constant: 8), cmd.trailingAnchor.constraint(equalTo: cmdBox.trailingAnchor, constant: -8),
            cmd.topAnchor.constraint(equalTo: cmdBox.topAnchor, constant: 6), cmd.bottomAnchor.constraint(equalTo: cmdBox.bottomAnchor, constant: -6),
            cmdBox.widthAnchor.constraint(equalToConstant: 232),
        ])
        button.target = target; button.action = copy
        button.bezelStyle = .rounded
        stack.orientation = .vertical; stack.alignment = .centerX; stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
        for v in [title, cost, cmdBox, button, foot] as [NSView] { stack.addArrangedSubview(v) }
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: content.leadingAnchor), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                                     stack.topAnchor.constraint(equalTo: content.topAnchor)])
    }

    func fill(title t: String, cost c: String, command cm: String?, foot f: String) {
        title.stringValue = t; cost.stringValue = c; foot.stringValue = f
        cost.isHidden = c.isEmpty
        command = cm ?? ""
        cmd.stringValue = command
        cmdBox.isHidden = command.isEmpty; button.isHidden = command.isEmpty
        stack.layoutSubtreeIfNeeded()
        let h = stack.fittingSize.height
        panel.setContentSize(NSSize(width: 260, height: h))
    }
}

// ---------------------------------------------------------------------------
// The app.
// ---------------------------------------------------------------------------
final class App: NSObject, NSApplicationDelegate {
    let args = CommandLine.arguments
    var fixedLevel: Double? = nil
    var watchFile = CACHE.appendingPathComponent("watch.json")
    let panel = PetPanel(contentRect: NSRect(x: 0, y: 0, width: PET, height: PET), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    let root = CALayer()
    var card: Card!
    var menu = NSMenu()
    var mtime: Date? = nil
    var level = 0.0, lastKind = -1
    var snapshot: [String: Any] = [:]
    var hiddenUntil: Date? = nil
    var reduceMotion = false
    var monitor: Any?
    var staleFlag = false

    var selfcheck: Bool { args.contains("--selfcheck") }

    func applicationDidFinishLaunching(_ n: Notification) {
        if let i = args.firstIndex(of: "--level"), i + 1 < args.count, let v = Double(args[i + 1]) { fixedLevel = v }
        if let i = args.firstIndex(of: "--watch-file"), i + 1 < args.count { watchFile = URL(fileURLWithPath: args[i + 1]) }

        configure(panel)
        let view = PetView(frame: NSRect(x: 0, y: 0, width: PET, height: PET))
        view.app = self
        view.wantsLayer = true
        root.bounds = CGRect(x: 0, y: 0, width: BOX, height: BOX)
        root.position = CGPoint(x: PET / 2, y: PET / 2)
        root.setAffineTransform(CGAffineTransform(scaleX: K, y: K))
        view.layer?.addSublayer(root)
        panel.contentView = view
        panel.setFrameOrigin(restoredOrigin())

        card = Card(target: self, copy: #selector(copyCommand))
        for (title, sel) in [("Hide for 1 hour", #selector(hideHour)), ("Hide", #selector(hideAll)), ("Quit", #selector(quit))] {
            let item = NSMenuItem(title: title, action: sel, keyEquivalent: ""); item.target = self; menu.addItem(item)
        }

        reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(self, selector: #selector(motionChanged), name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(pauseDrawing), name: NSWorkspace.screensDidSleepNotification, object: nil)
        nc.addObserver(self, selector: #selector(resumeDrawing), name: NSWorkspace.screensDidWakeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(occlusion), name: NSWindow.didChangeOcclusionStateNotification, object: panel)
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)

        // Where the transparent part of the window is, clicks should go through to what is behind.
        // Until the cursor is known to be outside the lantern, the window takes clicks.
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] _ in self?.hitTest() }

        render(wake: false)
        panel.orderFrontRegardless()
        if selfcheck { DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.runSelfcheck() }; return }

        watchParent()
        poll()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.poll() }
    }

    // --- life: it lives and dies with the watcher ---------------------------------------------
    // The watcher holds our stdin open. When it goes away, however it goes (even kill -9), the read
    // returns EOF and we leave. The parent's own exit is the backup.
    func watchParent() {
        DispatchQueue.global().async {
            while FileHandle.standardInput.availableData.count > 0 {}
            FileHandle.standardError.write("pet: stdin closed, leaving\n".data(using: .utf8)!)
            exit(0)
        }
        let src = DispatchSource.makeProcessSource(identifier: getppid(), eventMask: .exit, queue: .main)
        src.setEventHandler { exit(0) }
        src.resume()
        _ = src
        keep = src
    }
    var keep: Any?

    // --- reading ---------------------------------------------------------------------------
    func poll() {
        if let hidden = hiddenUntil, Date() >= hidden { hiddenUntil = nil; panel.orderFrontRegardless() }
        if let v = fixedLevel { setLevel(v); return }
        let attrs = try? FileManager.default.attributesOfItem(atPath: watchFile.path)
        let m = attrs?[.modificationDate] as? Date
        guard let data = try? Data(contentsOf: watchFile), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if (obj["running"] as? Bool) == false { exit(0) }
        let at = (obj["at"] as? Double) ?? 0, every = (obj["intervalMs"] as? Double) ?? 30_000
        let stale = Date().timeIntervalSince1970 * 1000 - at > max(3 * every, 90_000)
        if m == mtime && stale == staleFlag { return }
        mtime = m; staleFlag = stale; snapshot = obj
        setLevel(stale ? 0 : ((obj["level"] as? Double) ?? 0))
    }

    func setLevel(_ l: Double) {
        let kind = kindOf(l)
        let changed = abs(l - level) > 0.0005 || lastKind < 0
        let wake = lastKind >= 0 && kind != lastKind
        level = l; lastKind = kind
        if changed { render(wake: wake) }
        refreshCard()
    }

    func render(wake: Bool) {
        drawScale = (panel.screen?.backingScaleFactor ?? 2) * K
        root.sublayers?.forEach { $0.removeFromSuperlayer() }
        root.addSublayer(buildLantern(poseOf(level), animate: !reduceMotion, wake: wake))
    }

    // --- the card --------------------------------------------------------------------------
    func refreshCard() {
        let h = snapshot["headline"] as? [String: Any]
        let state = stateName(level), n = Int((level * 100).rounded())
        let active = (snapshot["active"] as? [Any])?.isEmpty == false
        var title = h?["title"] as? String ?? (active ? "still watching a problem" : "all quiet")
        var foot = "\(state) · level \(n)"
        if staleFlag { title = "reckon watch seems to have stopped"; foot = "nothing is being watched" }
        card.fill(title: title, cost: staleFlag ? "" : (h?["cost"] as? String ?? ""), command: staleFlag ? nil : h?["command"] as? String, foot: foot)
        if card.panel.isVisible { placeCard() }
    }

    func toggleCard() {
        if card.panel.isVisible { card.panel.orderOut(nil); card.closeTimer?.invalidate(); return }
        refreshCard(); placeCard()
        card.panel.orderFrontRegardless()
        card.closeTimer?.invalidate()
        card.closeTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in self?.card.panel.orderOut(nil) }
    }
    func cardFollows() { if card.panel.isVisible { placeCard() } }

    func placeCard() {
        let pf = panel.frame, cs = card.panel.frame.size
        let screen = panel.screen ?? NSScreen.main!, vf = screen.visibleFrame
        let onRight = pf.midX > vf.midX
        var x = onRight ? pf.minX - cs.width - 6 : pf.maxX + 6
        var y = pf.midY - cs.height / 2
        x = min(max(x, vf.minX), vf.maxX - cs.width)
        y = min(max(y, vf.minY), vf.maxY - cs.height)
        card.panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    @objc func copyCommand() {
        let pb = NSPasteboard.general
        pb.clearContents(); pb.setString(card.command, forType: .string)
        card.button.title = "copied"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in self?.card.button.title = "copy the command" }
    }

    // --- menu -------------------------------------------------------------------------------
    @objc func hideHour() { hide(until: Date().addingTimeInterval(3600)) }
    @objc func hideAll() { hide(until: Date.distantFuture) }
    func hide(until d: Date) { hiddenUntil = d; panel.orderOut(nil); card.panel.orderOut(nil) }
    @objc func quit() { exit(0) }

    // --- motion, sleep and screens ----------------------------------------------------------
    @objc func motionChanged() { reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion; render(wake: false) }
    @objc func pauseDrawing() { root.speed = 0 }
    @objc func resumeDrawing() { root.speed = 1 }
    @objc func occlusion() { root.speed = panel.occlusionState.contains(.visible) ? 1 : 0 }
    @objc func screensChanged() { clamp(); savePosition() }

    func hitTest() {
        let p = NSEvent.mouseLocation, f = panel.frame
        guard f.contains(p) else { return }
        let bx = (p.x - f.minX) / K, by = Double(BOX) - (p.y - f.minY) / K   // back to the box, y down
        let inside = bx >= 24 && bx <= 96 && by >= 13 && by <= 113
        panel.ignoresMouseEvents = !inside
    }

    // --- where it sits ----------------------------------------------------------------------
    func uuid(_ s: NSScreen) -> String? {
        guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
              let u = CGDisplayCreateUUIDFromDisplayID(n)?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, u) as String
    }

    // Stored as a display and a fraction of its free area, so it survives a change of resolution.
    func restoredOrigin() -> NSPoint {
        var rx = 0.985, ry = 0.03
        var screen = NSScreen.main ?? NSScreen.screens[0]
        let file = CACHE.appendingPathComponent("pet.json")
        if let d = try? Data(contentsOf: file), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            if let id = o["display"] as? String, let s = NSScreen.screens.first(where: { uuid($0) == id }) { screen = s }
            rx = (o["rx"] as? Double) ?? rx; ry = (o["ry"] as? Double) ?? ry
        }
        let vf = screen.visibleFrame
        return NSPoint(x: vf.minX + CGFloat(rx) * (vf.width - PET), y: vf.minY + CGFloat(ry) * (vf.height - PET))
    }

    func clamp() {
        let f = panel.frame
        guard let s = panel.screen ?? NSScreen.main else { return }
        let vf = s.visibleFrame
        panel.setFrameOrigin(NSPoint(x: min(max(f.minX, vf.minX), vf.maxX - PET), y: min(max(f.minY, vf.minY), vf.maxY - PET)))
    }

    func savePosition() {
        guard let s = panel.screen ?? NSScreen.main, let id = uuid(s) else { return }
        let vf = s.visibleFrame, f = panel.frame
        let rx = (f.minX - vf.minX) / max(1, vf.width - PET), ry = (f.minY - vf.minY) / max(1, vf.height - PET)
        let o: [String: Any] = ["display": id, "rx": min(max(rx, 0), 1), "ry": min(max(ry, 0), 1)]
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
        try? FileManager.default.createDirectory(at: CACHE, withIntermediateDirectories: true)
        try? d.write(to: CACHE.appendingPathComponent("pet.json"), options: .atomic)
    }

    // --- --selfcheck: ask the window server, not ourselves ----------------------------------
    func runSelfcheck() {
        let me = Int(getpid())
        let all = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []   // front to back
        var ours: (index: Int, layer: Int)? = nil, firstApp: Int? = nil
        for (i, w) in all.enumerated() {
            let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? -1, layer = (w[kCGWindowLayer as String] as? Int) ?? -1
            let b = w[kCGWindowBounds as String] as? [String: Any]
            let big = ((b?["Width"] as? Double) ?? 0) >= 300
            if pid == me && ours == nil { ours = (i, layer) }
            if pid != me && layer == 0 && big && firstApp == nil { firstApp = i }
        }
        var problems: [String] = []
        if ours == nil { problems.append("our window is not on screen") }
        if let o = ours, o.layer != 1000 { problems.append("our window is at layer \(o.layer), not 1000") }
        if let o = ours, let a = firstApp, o.index > a { problems.append("an app window is in front of ours") }
        let line: [String: Any] = ["ok": problems.isEmpty, "layer": ours?.layer ?? NSNull(), "aboveFrontApp": (ours != nil && (firstApp == nil || ours!.index < firstApp!)),
                                   "appWindowFound": firstApp != nil, "problems": problems]
        let d = try! JSONSerialization.data(withJSONObject: line, options: [.sortedKeys])
        FileHandle.standardOutput.write(d); FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        exit(problems.isEmpty ? 0 : 1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = App()
app.delegate = delegate
app.run()
