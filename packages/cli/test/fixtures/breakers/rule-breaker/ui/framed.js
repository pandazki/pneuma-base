/* global pneuma, document */
pneuma.onData((data) => {
  document.getElementById('data').textContent = JSON.stringify(data)
})
