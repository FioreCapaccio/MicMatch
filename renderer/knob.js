// MicMatch - controllo "knob" rotativo stile mixer hardware.
// Puro DOM/SVG, nessuna libreria esterna. Interazione: trascinamento
// verticale (su = aumenta, giu' = diminuisce, come su un mixer reale),
// rotellina del mouse, doppio click per riportare al valore di default,
// frecce su/giu' da tastiera quando il knob ha il focus.

(function () {
  const MIN_ANGLE = -135; // gradi, posizione al valore minimo
  const MAX_ANGLE = 135; // gradi, posizione al valore massimo
  const DRAG_RANGE_PX = 160; // px di trascinamento verticale per coprire l'intero range
  const FINE_DIVISOR = 6; // shift+trascina = regolazione fine

  const SVG_NS = "http://www.w3.org/2000/svg";
  const SIZE = 120;
  const CENTER = SIZE / 2;
  const KNOB_RADIUS = 30;
  const SCALE_RADIUS = 46;

  let gradCounter = 0;

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  function polar(cx, cy, r, angleDeg) {
    const a = ((angleDeg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  function describeArc(cx, cy, r, startAngle, endAngle) {
    if (Math.abs(endAngle - startAngle) < 0.01) {
      const [x, y] = polar(cx, cy, r, startAngle);
      return `M ${x} ${y}`;
    }
    const [x1, y1] = polar(cx, cy, r, startAngle);
    const [x2, y2] = polar(cx, cy, r, endAngle);
    const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
  }

  class Knob {
    constructor(container, opts) {
      this.container = container;
      this.min = opts.min;
      this.max = opts.max;
      this.step = opts.step || 1;
      this.defaultValue = opts.defaultValue !== undefined ? opts.defaultValue : opts.value;
      this.value = opts.value !== undefined ? opts.value : this.defaultValue;
      this.unit = opts.unit || "";
      this.label = opts.label || "";
      this.decimals = opts.decimals !== undefined ? opts.decimals : this.step < 1 ? 1 : 0;
      this.onChange = opts.onChange || (() => {});
      this._build();
      this._render();
    }

    _valueToAngle(value) {
      const t = (value - this.min) / (this.max - this.min);
      return MIN_ANGLE + t * (MAX_ANGLE - MIN_ANGLE);
    }

    _build() {
      const wrap = document.createElement("div");
      wrap.className = "knob-widget";
      wrap.tabIndex = 0;

      const svg = svgEl("svg", {
        viewBox: `0 0 ${SIZE} ${SIZE}`,
        width: SIZE,
        height: SIZE,
        class: "knob-svg",
      });

      const gradId = `knobGrad-${gradCounter++}`;
      const defs = svgEl("defs", {});
      const grad = svgEl("radialGradient", { id: gradId, cx: "35%", cy: "30%", r: "75%" });
      grad.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#4d525f" }));
      grad.appendChild(svgEl("stop", { offset: "55%", "stop-color": "#2b2e37" }));
      grad.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#15171c" }));
      defs.appendChild(grad);
      svg.appendChild(defs);

      svg.appendChild(
        svgEl("path", {
          d: describeArc(CENTER, CENTER, SCALE_RADIUS, MIN_ANGLE, MAX_ANGLE),
          class: "knob-scale-bg",
        })
      );

      const valueArc = svgEl("path", { class: "knob-scale-value" });
      svg.appendChild(valueArc);
      this._valueArc = valueArc;

      const tickCount = 11;
      for (let i = 0; i < tickCount; i++) {
        const t = i / (tickCount - 1);
        const angle = MIN_ANGLE + t * (MAX_ANGLE - MIN_ANGLE);
        const major = i % 5 === 0;
        const r1 = SCALE_RADIUS + (major ? 7 : 4);
        const r2 = SCALE_RADIUS + 10;
        const [x1, y1] = polar(CENTER, CENTER, r1, angle);
        const [x2, y2] = polar(CENTER, CENTER, r2, angle);
        svg.appendChild(
          svgEl("line", { x1, y1, x2, y2, class: major ? "knob-tick knob-tick-major" : "knob-tick" })
        );
      }

      svg.appendChild(
        svgEl("circle", { cx: CENTER, cy: CENTER, r: KNOB_RADIUS, class: "knob-body", fill: `url(#${gradId})` })
      );
      svg.appendChild(svgEl("circle", { cx: CENTER, cy: CENTER, r: KNOB_RADIUS, class: "knob-body-ring" }));
      svg.appendChild(
        svgEl("circle", { cx: CENTER, cy: CENTER, r: KNOB_RADIUS - 4, class: "knob-body-highlight" })
      );

      const pointerGroup = svgEl("g", { class: "knob-pointer-group" });
      pointerGroup.appendChild(
        svgEl("line", {
          x1: CENTER,
          y1: CENTER - KNOB_RADIUS * 0.2,
          x2: CENTER,
          y2: CENTER - KNOB_RADIUS * 0.88,
          class: "knob-pointer",
        })
      );
      svg.appendChild(pointerGroup);
      this._pointerGroup = pointerGroup;

      wrap.appendChild(svg);

      const readout = document.createElement("div");
      readout.className = "knob-readout";
      wrap.appendChild(readout);
      this._readout = readout;

      if (this.label) {
        const labelEl = document.createElement("div");
        labelEl.className = "knob-label";
        labelEl.textContent = this.label;
        wrap.appendChild(labelEl);
      }

      this.container.appendChild(wrap);
      this._wrap = wrap;
      this._svg = svg;

      this._attachInteraction();
    }

    _attachInteraction() {
      let dragging = false;
      let startY = 0;
      let startValue = 0;

      const onPointerDown = (e) => {
        dragging = true;
        startY = e.clientY;
        startValue = this.value;
        this._wrap.classList.add("dragging");
        this._wrap.focus();
        e.preventDefault();
      };

      const onPointerMove = (e) => {
        if (!dragging) return;
        const deltaY = startY - e.clientY;
        const divisor = e.shiftKey ? DRAG_RANGE_PX * FINE_DIVISOR : DRAG_RANGE_PX;
        const deltaValue = (deltaY / divisor) * (this.max - this.min);
        this.setValue(startValue + deltaValue, true);
      };

      const onPointerUp = () => {
        if (!dragging) return;
        dragging = false;
        this._wrap.classList.remove("dragging");
      };

      this._svg.addEventListener("mousedown", onPointerDown);
      window.addEventListener("mousemove", onPointerMove);
      window.addEventListener("mouseup", onPointerUp);

      this._svg.addEventListener("dblclick", () => this.setValue(this.defaultValue, true));

      this._svg.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const dir = e.deltaY < 0 ? 1 : -1;
          this.setValue(this.value + dir * this.step, true);
        },
        { passive: false }
      );

      this._wrap.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowRight") {
          e.preventDefault();
          this.setValue(this.value + this.step, true);
        } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
          e.preventDefault();
          this.setValue(this.value - this.step, true);
        } else if (e.key === "PageUp") {
          e.preventDefault();
          this.setValue(this.value + this.step * 5, true);
        } else if (e.key === "PageDown") {
          e.preventDefault();
          this.setValue(this.value - this.step * 5, true);
        }
      });
    }

    setValue(raw, notify) {
      let v = Math.round(raw / this.step) * this.step;
      v = Math.min(this.max, Math.max(this.min, v));
      if (Object.is(v, -0)) v = 0;
      this.value = v;
      this._render();
      if (notify) this.onChange(this.value);
    }

    _render() {
      const angle = this._valueToAngle(this.value);
      this._pointerGroup.setAttribute("transform", `rotate(${angle} ${CENTER} ${CENTER})`);
      this._valueArc.setAttribute("d", describeArc(CENTER, CENTER, SCALE_RADIUS, MIN_ANGLE, angle));
      this._readout.textContent = `${this.value.toFixed(this.decimals)}${this.unit}`;
    }
  }

  window.MicMatchKnob = Knob;

  // -------------------------------------------------------------------
  // Selettore rotante a scatti (posizioni fisse), stile switch da mixer.
  // A differenza del Knob (continuo), qui il valore salta tra un elenco
  // fisso di opzioni - pensato per scegliere tra standard/preset invece
  // di regolare una quantità.
  // -------------------------------------------------------------------

  const SELECTOR_DRAG_STEP_PX = 30; // px di trascinamento verticale per uno scatto

  class RotarySelector {
    constructor(container, opts) {
      this.container = container;
      this.options = opts.options; // [{ value, name, detail }]
      this.defaultIndex = opts.defaultIndex ?? 0;
      this.index = opts.defaultIndex ?? 0;
      this.label = opts.label || "";
      this.onChange = opts.onChange || (() => {});
      this._build();
      this._render();
    }

    get value() {
      return this.options[this.index].value;
    }
    get option() {
      return this.options[this.index];
    }

    _indexToAngle(index) {
      const n = this.options.length;
      if (n <= 1) return 0;
      const t = index / (n - 1);
      return MIN_ANGLE + t * (MAX_ANGLE - MIN_ANGLE);
    }

    setIndex(rawIndex, notify) {
      const n = this.options.length;
      const index = ((Math.round(rawIndex) % n) + n) % n;
      const changed = index !== this.index;
      this.index = index;
      this._render();
      if (notify && changed) this.onChange(this.value, this.option);
    }

    setValueIfExists(value, notify) {
      const i = this.options.findIndex((o) => o.value === value);
      if (i >= 0) this.setIndex(i, notify);
    }

    _build() {
      const wrap = document.createElement("div");
      wrap.className = "knob-widget knob-widget--selector";
      wrap.tabIndex = 0;

      const svg = svgEl("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, width: SIZE, height: SIZE, class: "knob-svg" });

      const gradId = `knobGrad-${gradCounter++}`;
      const defs = svgEl("defs", {});
      const grad = svgEl("radialGradient", { id: gradId, cx: "35%", cy: "30%", r: "75%" });
      grad.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#4d525f" }));
      grad.appendChild(svgEl("stop", { offset: "55%", "stop-color": "#2b2e37" }));
      grad.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#15171c" }));
      defs.appendChild(grad);
      svg.appendChild(defs);

      svg.appendChild(
        svgEl("path", { d: describeArc(CENTER, CENTER, SCALE_RADIUS, MIN_ANGLE, MAX_ANGLE), class: "knob-scale-bg" })
      );
      const valueArc = svgEl("path", { class: "knob-scale-value" });
      svg.appendChild(valueArc);
      this._valueArc = valueArc;

      // una tacca per ogni posizione fissa, invece della scala continua
      this.options.forEach((_, i) => {
        const angle = this._indexToAngle(i);
        const [x1, y1] = polar(CENTER, CENTER, SCALE_RADIUS + 7, angle);
        const [x2, y2] = polar(CENTER, CENTER, SCALE_RADIUS + 10, angle);
        svg.appendChild(svgEl("line", { x1, y1, x2, y2, class: "knob-tick knob-tick-major" }));
      });

      svg.appendChild(svgEl("circle", { cx: CENTER, cy: CENTER, r: KNOB_RADIUS, class: "knob-body", fill: `url(#${gradId})` }));
      svg.appendChild(svgEl("circle", { cx: CENTER, cy: CENTER, r: KNOB_RADIUS, class: "knob-body-ring" }));
      svg.appendChild(svgEl("circle", { cx: CENTER, cy: CENTER, r: KNOB_RADIUS - 4, class: "knob-body-highlight" }));

      const pointerGroup = svgEl("g", { class: "knob-pointer-group" });
      pointerGroup.appendChild(
        svgEl("line", {
          x1: CENTER, y1: CENTER - KNOB_RADIUS * 0.2, x2: CENTER, y2: CENTER - KNOB_RADIUS * 0.88,
          class: "knob-pointer",
        })
      );
      svg.appendChild(pointerGroup);
      this._pointerGroup = pointerGroup;

      wrap.appendChild(svg);

      const readout = document.createElement("div");
      readout.className = "knob-readout knob-readout--selector";
      wrap.appendChild(readout);
      this._readout = readout;

      if (this.label) {
        const labelEl = document.createElement("div");
        labelEl.className = "knob-label";
        labelEl.textContent = this.label;
        wrap.appendChild(labelEl);
      }

      this.container.appendChild(wrap);
      this._wrap = wrap;
      this._svg = svg;

      this._attachInteraction();
    }

    _attachInteraction() {
      let dragging = false;
      let startY = 0;
      let startIndex = 0;
      let moved = false;

      const onDown = (e) => {
        dragging = true;
        moved = false;
        startY = e.clientY;
        startIndex = this.index;
        this._wrap.classList.add("dragging");
        this._wrap.focus();
        e.preventDefault();
      };

      const onMove = (e) => {
        if (!dragging) return;
        const deltaY = startY - e.clientY;
        if (Math.abs(deltaY) > 3) moved = true;
        const steps = Math.round(deltaY / SELECTOR_DRAG_STEP_PX);
        this.setIndex(startIndex + steps, true);
      };

      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        this._wrap.classList.remove("dragging");
        if (!moved) this.setIndex(this.index + 1, true); // click semplice = avanza di uno scatto
      };

      this._svg.addEventListener("mousedown", onDown);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);

      this._svg.addEventListener("dblclick", () => this.setIndex(this.defaultIndex, true));

      this._svg.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const dir = e.deltaY < 0 ? 1 : -1;
          this.setIndex(this.index + dir, true);
        },
        { passive: false }
      );

      this._wrap.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowRight") {
          e.preventDefault();
          this.setIndex(this.index + 1, true);
        } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
          e.preventDefault();
          this.setIndex(this.index - 1, true);
        }
      });
    }

    _render() {
      const angle = this._indexToAngle(this.index);
      this._pointerGroup.setAttribute("transform", `rotate(${angle} ${CENTER} ${CENTER})`);
      this._valueArc.setAttribute("d", describeArc(CENTER, CENTER, SCALE_RADIUS, MIN_ANGLE, angle));
      const opt = this.option;
      this._readout.innerHTML = opt.detail
        ? `${opt.name}<br><span class="knob-readout-detail">${opt.detail}</span>`
        : opt.name;
    }
  }

  window.MicMatchSelector = RotarySelector;
})();
