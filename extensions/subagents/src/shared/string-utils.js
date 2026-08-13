export function sliceSafe(value, end) {
    const sliced = value.slice(0, end);
    const last = sliced.charCodeAt(sliced.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}
export function truncateWithMarker(value, maxChars, marker) {
    if (value.length <= maxChars)
        return value;
    if (marker.length >= maxChars)
        return sliceSafe(marker, maxChars);
    return `${sliceSafe(value, maxChars - marker.length)}${marker}`;
}
