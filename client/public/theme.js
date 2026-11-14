(function () {
  var pref = "system";
  try {
    pref = localStorage.getItem("theme") || "system";
  } catch (e) {}
  var dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
})();
