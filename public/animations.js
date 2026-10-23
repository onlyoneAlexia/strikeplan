const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const flow = document.querySelector('.flow');
let signalTimer;
window.signalbridgeMotion = {
  signal() {
    if (reduced.matches || !flow) return;
    flow.classList.remove('is-transmitting');
    requestAnimationFrame(() => requestAnimationFrame(() => flow.classList.add('is-transmitting')));
    clearTimeout(signalTimer);
    signalTimer = setTimeout(() => flow.classList.remove('is-transmitting'), 2100);
  }
};
if (!reduced.matches && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => { if(entry.isIntersecting) { entry.target.classList.add('in-view'); observer.unobserve(entry.target); } });
  }, { threshold: .06 });
  document.querySelectorAll('.flow,.metrics,.setup,.columns>.card,.tester,.activity').forEach(node => { node.classList.add('motion-ready'); observer.observe(node); });
  reduced.addEventListener('change', event => { if(event.matches) { observer.disconnect(); document.querySelectorAll('.motion-ready').forEach(node => node.classList.add('in-view')); } });
}
document.addEventListener('pointerdown', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled || reduced.matches || button.classList.contains('text-button')) return;
  const rect = button.getBoundingClientRect(), ripple = document.createElement('span');
  ripple.className = 'button-ripple'; ripple.setAttribute('aria-hidden','true');
  ripple.style.left = `${event.clientX - rect.left}px`; ripple.style.top = `${event.clientY - rect.top}px`;
  button.append(ripple); ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
});
