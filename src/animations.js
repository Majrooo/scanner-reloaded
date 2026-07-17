/**
 * Pomocné matematické interpolácie a prechody pre Sunburst graf.
 */
const SunburstAnimations = {
  /**
   * Štandardný zoom prechod medzi starým a novým stavom uzlov.
   * Interpoluje nielen uhly (x0, x1), ale aj vnútorný a vonkajší polomer,
   * aby animácia pôsobila plynule pri zmene medzi rôznymi úrovňami.
   */
  arcTween(oldNode, newNode, arcGenerator) {
    const interpX0 = d3.interpolate(oldNode.x0, newNode.x0);
    const interpX1 = d3.interpolate(oldNode.x1, newNode.x1);
    // Radii - používame uložené hodnoty z __arcData, ak existujú,
    // inak ich dopočítame z arcGeneratora pre starý aj nový uzol.
    const oldInner = oldNode.innerRadius !== undefined ? oldNode.innerRadius : arcGenerator.innerRadius()(oldNode);
    const oldOuter = oldNode.outerRadius !== undefined ? oldNode.outerRadius : arcGenerator.outerRadius()(oldNode);
    const newInner = newNode.innerRadius !== undefined ? newNode.innerRadius : arcGenerator.innerRadius()(newNode);
    const newOuter = newNode.outerRadius !== undefined ? newNode.outerRadius : arcGenerator.outerRadius()(newNode);
    const interpInner = d3.interpolate(oldInner, newInner);
    const interpOuter = d3.interpolate(oldOuter, newOuter);
    return function (t) {
      return arcGenerator({
        x0: interpX0(t),
        x1: interpX1(t),
        innerRadius: interpInner(t),
        outerRadius: interpOuter(t),
        depth: newNode.depth,
        data: newNode.data,
        value: newNode.value
      });
    };
  },

  /**
   * Intro animácia: "Vejárové rozbalenie" (Sweep)
   */
  sweepTween(d, p, arcGenerator) {
    const targetEndAngle = Math.max(0, Math.min(2 * Math.PI, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI;
    const startAngleValue = Math.max(0, Math.min(2 * Math.PI, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI;
    const interpolateEnd = d3.interpolate(startAngleValue, targetEndAngle);

    return function (t) {
      return arcGenerator({
        x0: d.x0,
        x1: p.x0 + (interpolateEnd(t) / (2 * Math.PI)) * (p.x1 - p.x0),
        depth: d.depth,
        data: d.data,
        value: d.value
      });
    };
  },

  /**
   * Intro animácia: "Expanzia zvnútra von" (Grow Outward)
   * Vylepšená: interpoluje polomery od nuly/stredu do reálnej pozície.
   */
  growTween(d, targetInnerRadius, targetOuterRadius, arcGenerator) {
    // Interpolujeme druhú odmocninu polomerov, aby bol vizuálny rast lineárny (keďže arc pracuje s r^2)
    const interpolateInnerRadius = d3.interpolate(0, Math.sqrt(targetInnerRadius));
    const interpolateOuterRadius = d3.interpolate(0, Math.sqrt(targetOuterRadius));

    return function (t) {
      // V každom kroku umocníme interpolovanú hodnotu, aby sme dostali skutočný polomer
      const currentInnerRadius = Math.pow(interpolateInnerRadius(t), 2);
      const currentOuterRadius = Math.pow(interpolateOuterRadius(t), 2);

      return arcGenerator({
        x0: d.x0,
        x1: d.x1,
        innerRadius: currentInnerRadius,
        outerRadius: currentOuterRadius,
        depth: d.depth,
        data: d.data,
        value: d.value
      });
    };
  },

  /**
   * Intro animácia: "Spiráľa" (Spiral)
   * Segmenty sa objavujú podľa ich úhlovej pozície vo vodorovnej osi grafu.
   */
  spiralTween(d, p, arcGenerator) {
    // Počiatočný koncový úhol je rovnaký ako počiatočný (žiadny segment)
    const targetEndAngle = Math.max(0, Math.min(2 * Math.PI, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI;
    const startAngleValue = Math.max(0, Math.min(2 * Math.PI, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI;
    
    // Oneskorenie závisí od počiatočného uhlu: čím je segment "vľavo" (menší úhol), tým skôr sa objaví
    const delay = (startAngleValue / (2 * Math.PI)) * 0.5; // maximálne 50% oneskorenia
    
    const interpolateEnd = d3.interpolate(startAngleValue, targetEndAngle);

    return function (t) {
      // Aplikujeme oneskorenie: animácia "začína" až po uplynutí času 'delay'
      const adjustedT = Math.max(0, Math.min(1, (t - delay) / (1 - delay)));
      
      return arcGenerator({
        x0: d.x0,
        x1: p.x0 + (interpolateEnd(adjustedT) / (2 * Math.PI)) * (p.x1 - p.x0),
        depth: d.depth,
        data: d.data,
        value: d.value
      });
    };
  },

  /**
   * Intro animácia: "Sekvenčné objavovanie" (Sequential - podľa veľkosti)
   * Najväčšie segmenty sa objavia ako prvé, najmenšie ako posledné.
   */
  sequentialTween(d, p, arcGenerator, index, total) {
    // Oneskorenie podľa poradia: prvý úsek má 0 oneskorenia, posledný maximum
    const delay = index / total * 0.6; // maximálne 60% oneskorenia
    
    const targetEndAngle = Math.max(0, Math.min(2 * Math.PI, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI;
    const startAngleValue = Math.max(0, Math.min(2 * Math.PI, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI;
    const interpolateEnd = d3.interpolate(startAngleValue, targetEndAngle);

    return function (t) {
      const adjustedT = Math.max(0, Math.min(1, (t - delay) / (1 - delay)));
      
      return arcGenerator({
        x0: d.x0,
        x1: p.x0 + (interpolateEnd(adjustedT) / (2 * Math.PI)) * (p.x1 - p.x0),
        depth: d.depth,
        data: d.data,
        value: d.value
      });
    };
  }
};

// Exponovanie objektu do globálneho window scope
window.SunburstAnimations = SunburstAnimations;