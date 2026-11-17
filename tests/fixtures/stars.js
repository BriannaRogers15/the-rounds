// Picks a value on a star picker (.star-slider) the way a person does:
// a click on the right spot. v.5 lands on the left half of star v+1,
// a whole v on the right half of star v.
async function pickStars(slider, value) {
  const icons = slider.locator('.ss-icons');
  const box = await icons.boundingBox();
  await slider.page().mouse.click(box.x + box.width * ((value - 0.25) / 5), box.y + box.height / 2);
}

module.exports = { pickStars };
