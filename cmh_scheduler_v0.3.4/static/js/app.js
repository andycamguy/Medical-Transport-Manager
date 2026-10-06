"use strict";

/* ==========================================================================
   CMH Medical Transportation Scheduler (demo)
   All data lives in the browser's localStorage. No real patient data.
   ========================================================================== */

const STORAGE_KEY = "cmh_scheduler_demo_v1";
const USER_KEY = "cmh_demo_user";
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DEFAULT_TRIP_MINUTES = 45;
const CONFLICT_WINDOW_MINUTES = 15;
const INACTIVE_STATUSES = ["canceled", "caa"];

// Timeline layout
const SLOT_MINUTES = 15;
const SLOT_PX = 48;
const TIMELINE_DEFAULT_START = 6 * 60;
const TIMELINE_DEFAULT_END = 22 * 60;

const seedData = {
  drivers: [
    // { id: "sarah", name: "Sarah Johnson", phone: "(859) 555-0101", title: "Driver", active: true, workDays: ["mon", "tue", "wed", "thu", "fri"] },
    // { id: "mike", name: "Mike Williams", phone: "(859) 555-0102", title: "Driver", active: true, workDays: ["mon", "wed", "fri"] },
    // { id: "john", name: "John Davis", phone: "(859) 555-0103", title: "Driver", active: true, workDays: ["tue", "wed", "thu", "sat"] },
  ],
  patients: [
    // { id: "p1", name: "John Smith", dob: "1954-04-12", phone: "(859) 555-1234", address: "123 Main Street\nLexington, KY 40508", mobility: "Power Wheelchair", chairWidth: 24, vehicleRequirement: "Silver", notes: "Chair over 22 inches. Rear wheelchair position required." },
    // { id: "p2", name: "Mary Jones", dob: "1948-09-22", phone: "(859) 555-3333", address: "789 Pine Road\nLexington, KY 40504", mobility: "Wheelchair", chairWidth: 20, vehicleRequirement: "Bronze", notes: "" },
    // { id: "p3", name: "Robert Brown", dob: "1951-01-18", phone: "(859) 555-1111", address: "123 Elm Street\nLexington, KY 40508", mobility: "Stretcher", chairWidth: null, vehicleRequirement: "Gold", notes: "Stretcher patient. Gold vehicle required." },
    // { id: "p4", name: "Jane Williams", dob: "1960-07-03", phone: "(859) 555-4444", address: "321 Maple Drive\nLexington, KY 40509", mobility: "Walker", chairWidth: null, vehicleRequirement: "Bronze", notes: "" },
    // { id: "p5", name: "William Davis", dob: "1946-11-30", phone: "(859) 555-2222", address: "456 Oak Avenue\nNicholasville, KY 40356", mobility: "Geriatric Chair", chairWidth: null, vehicleRequirement: "Gold", notes: "Requires bench seating." },
  ],
  appointments: [],
};

const UNKNOWN_PATIENT = { id: "", name: "Unknown Patient", dob: "", phone: "", address: "", mobility: "", chairWidth: null, vehicleRequirement: "", notes: "" };
const UNKNOWN_DRIVER = { id: "", name: "Unknown Driver", phone: "", title: "", active: false, workDays: [] };

/* --------------------------------------------------------------------------
   Small helpers
   -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

// Re-draws whatever page is open when the saved data changes (another tab, or Back/Forward).
let pageRefresh = null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}
function escLines(value) {
  return esc(value).replaceAll("\n", "<br>");
}
function firstLine(value) {
  return String(value ?? "").split("\n")[0];
}
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayISO() {
  return localISO(new Date());
}
function minutes(t) {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
}
function minutesToTime(total) {
  const m = Math.min(Math.max(Math.round(total), 0), 24 * 60 - 1);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function formatTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
function formatDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
function formatShortDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function roundDown15(n) {
  return Math.floor(n / SLOT_MINUTES) * SLOT_MINUTES;
}
function roundUp15(n) {
  return Math.ceil(n / SLOT_MINUTES) * SLOT_MINUTES;
}
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/* --------------------------------------------------------------------------
   Data layer
   -------------------------------------------------------------------------- */

function findPatient(d, id) {
  return d.patients.find((p) => p.id === id);
}
function findDriver(d, id) {
  return d.drivers.find((x) => x.id === id);
}
// Safe lookups for rendering: never undefined, so one bad id cannot break a page.
function getPatient(d, id) {
  return findPatient(d, id) || UNKNOWN_PATIENT;
}
function getDriver(d, id) {
  return findDriver(d, id) || UNKNOWN_DRIVER;
}

function normalizeTrip(t) {
  return {
    ...t,
    durationMinutes: Number(t.durationMinutes) || DEFAULT_TRIP_MINUTES,
    status: !t.status || t.status === "scheduled" ? "not-ready" : t.status,
  };
}

function normalizeData(d) {
  d = d && typeof d === "object" ? d : {};
  d.patients = Array.isArray(d.patients) ? d.patients : [];
  d.drivers = (Array.isArray(d.drivers) ? d.drivers : []).map((x) => ({
    ...x,
    active: x.active !== false,
    workDays: Array.isArray(x.workDays) ? x.workDays : ["mon", "tue", "wed", "thu", "fri"],
  }));
  d.appointments = (Array.isArray(d.appointments) ? d.appointments : [])
    .filter((a) => a && a.outbound)
    .map((a) => ({
      ...a,
      oneWay: a.oneWay === true,
      outbound: normalizeTrip(a.outbound),
      return: a.return ? normalizeTrip(a.return) : null,
      additionalTrips: Array.isArray(a.additionalTrips) ? a.additionalTrips.map(normalizeTrip) : [],
    }));
  return d;
}

function getData() {
  if (window.APP_DATA) return normalizeData(window.APP_DATA);
  return normalizeData({ patients: [], drivers: [], appointments: [] });
}

function restoreSeedData() {
  return normalizeData(window.APP_DATA || { patients: [], drivers: [], appointments: [] });
}

async function saveData(d) {
  try {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
    const response = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
      credentials: "same-origin",
      body: JSON.stringify(d),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Save failed (${response.status})`);
    }

    window.APP_DATA = d;
    return true;
  } catch (err) {
    console.error("Could not save data.", err);
    alert("Could not save your changes. Please try again.");
    return false;
  }
}

async function resetDemoData() {
  if (!confirm("Reset all demo data back to the starting examples? Anything you added will be lost.")) return;
  try {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
    const response = await fetch("/api/reset", {
      method: "POST",
      headers: { "X-CSRFToken": csrfToken },
      credentials: "same-origin",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || "Reset failed");
    location.reload();
  } catch (err) {
    alert("Could not reset the demo data.");
    console.error(err);
  }
}

function makeAppointment(id, patientId, date, outPickup, medicalTime, outDriver, outDuration, retPickup, retDriver, retDuration, pickupAddress, destination, type, notes, oneWay = false) {
  return {
    id,
    patientId,
    date,
    medicalAppointmentTime: medicalTime,
    type,
    notes,
    oneWay: oneWay === true,
    outbound: {
      id: id + "-out",
      pickupTime: outPickup,
      driverId: outDriver,
      durationMinutes: Number(outDuration) || DEFAULT_TRIP_MINUTES,
      pickupAddress,
      destination,
      status: "not-ready",
      notes: ""
    },
    return: oneWay
      ? null
      : (retPickup || retDriver
        ? {
            id: id + "-return",
            pickupTime: retPickup || "",
            driverId: retDriver || "",
            durationMinutes: Number(retDuration) || DEFAULT_TRIP_MINUTES,
            pickupAddress: destination,
            destination: pickupAddress,
            status: "not-ready",
            notes: ""
          }
        : null),
    additionalTrips: [],
  };
}

function createSeedData() {
  const d = structuredClone(seedData);
  const date = todayISO();
  // d.appointments = [
  //   makeAppointment("a1", "p1", date, "07:45", "08:30", "sarah", 45, "11:30", "mike", 45, "123 Main Street\nLexington, KY 40508", "UK Hospital\nLexington, KY 40506", "Doctor Appointment", "Chair over 22 inches. Rear position required."),
  //   makeAppointment("a2", "p2", date, "08:00", "09:00", "sarah", 60, "12:00", "sarah", 45, "789 Pine Road\nLexington, KY 40504", "UK Hospital\nLexington, KY 40506", "Doctor Appointment", "Same destination as John. Shared transportation is intentional."),
  //   makeAppointment("a3", "p3", date, "09:30", "10:30", "john", 60, "13:00", "mike", 60, "123 Elm Street\nLexington, KY 40508", "VA Clinic\nLexington, KY 40505", "Procedure", "Stretcher patient."),
  //   makeAppointment("a4", "p4", date, "10:30", "11:30", "sarah", 60, "14:00", "john", 45, "321 Maple Drive\nLexington, KY 40509", "Bluegrass Clinic\nLexington, KY 40508", "Therapy", ""),
  //   makeAppointment("a5", "p5", date, "13:30", "14:30", "mike", 60, "16:00", "mike", 45, "456 Oak Avenue\nNicholasville, KY 40356", "Baptist Health\nLexington, KY 40508", "Procedure", "Requires bench seating."),
  // ];
  return d;
}

function allTrips(d) {
  const trips = [];

  d.appointments.forEach((a) => {
    const shared = {
      appointmentId: a.id,
      patientId: a.patientId,
      date: a.date,
      medicalAppointmentTime: a.medicalAppointmentTime,
      appointmentType: a.type,
      appointmentNotes: a.notes || ""
    };

    if (a.outbound) {
      trips.push({ ...a.outbound, ...shared, direction: "Outbound" });
    }

    if (a.return && a.return.pickupTime) {
      trips.push({ ...a.return, ...shared, direction: "Return" });
    }

    (a.additionalTrips || []).forEach((trip, index) => {
      if (trip.pickupTime) {
        trips.push({
          ...trip,
          ...shared,
          direction: trip.direction || `Additional Trip ${index + 1}`
        });
      }
    });
  });

  return trips;
}

// Canceled and CAA trips stay visible in history but never take up a driver's time.
function isActiveTrip(t) {
  return !INACTIVE_STATUSES.includes(t.status);
}
function byPickupTime(a, b) {
  return minutes(a.pickupTime) - minutes(b.pickupTime);
}

/* --------------------------------------------------------------------------
   Status helpers
   -------------------------------------------------------------------------- */

function statusLabel(status) {
  return { "not-ready": "Not Ready for Pickup", ready: "Ready for Pickup", "in-progress": "In Progress", completed: "Completed", canceled: "Canceled", caa: "CAA" }[status] || "Not Ready for Pickup";
}
function statusClass(status) {
  return status || "not-ready";
}
// CSS class used to color timeline blocks and status buttons.
function blockColorClass(status) {
  return { "not-ready": "status-not-ready", ready: "status-ready", "in-progress": "status-progress", completed: "status-complete" }[status] || "status-not-ready";
}

/* --------------------------------------------------------------------------
   Users and drivers
   -------------------------------------------------------------------------- */

function currentUser() {
  return window.CURRENT_USER?.driverId || "ben";
}
function setCurrentUser(id) {
  // Real authentication controls the current user in v0.3.4.
}

function isWorkingOn(driver, iso) {
  if (!driver || driver.active === false) return false;
  const day = DAY_NAMES[new Date(`${iso}T12:00:00`).getDay()];
  return (driver.workDays || []).map((x) => x.toLowerCase()).includes(day);
}
function isWorkingToday(driver) {
  return isWorkingOn(driver, todayISO());
}
function activeDrivers(d) {
  return d.drivers.filter((x) => x.active !== false);
}

/* --------------------------------------------------------------------------
   Navigation
   -------------------------------------------------------------------------- */

function initNav() {
  const p = location.pathname;
  let page = null;
  if (p === "/") page = "today";
  else if (p.startsWith("/calendar")) page = "calendar";
  else if (p === "/patients" || p.startsWith("/patient/")) page = "patients";
  else if (p === "/appointment/new") page = "appointment";
  else if (p === "/driver") page = "driver";
  else if (p === "/drivers") page = "drivers";
  document.querySelectorAll(".main-nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === page));


}

/* --------------------------------------------------------------------------
   Today page + daily timeline
   -------------------------------------------------------------------------- */

function buildTimelineBlocks(d, date) {
  return allTrips(d)
    .filter((t) => t.date === date && isActiveTrip(t))
    .map((t) => ({
      tripId: t.id,
      appointmentId: t.appointmentId,
      driverId: t.driverId,
      start: minutes(t.pickupTime),
      end: minutes(t.pickupTime) + t.durationMinutes,
      status: t.status,
      patientId: t.patientId,
      direction: t.direction,
      pickupTime: t.pickupTime,
      durationMinutes: t.durationMinutes,
    }));
}

// Trips for the same driver that overlap in time are placed side by side.
function assignLanes(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
  let cluster = [];
  let clusterEnd = -1;
  let laneEnds = [];
  const flush = () => {
    cluster.forEach((b) => (b.lanes = laneEnds.length));
    cluster = [];
    laneEnds = [];
    clusterEnd = -1;
  };
  sorted.forEach((b) => {
    if (cluster.length && b.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= b.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = b.end;
    b.lane = lane;
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.end);
  });
  flush();
  return sorted;
}

function timelineBounds(blocks) {
  let start = TIMELINE_DEFAULT_START;
  let end = TIMELINE_DEFAULT_END;
  blocks.forEach((b) => {
    start = Math.min(start, roundDown15(b.start));
    end = Math.max(end, roundUp15(b.end));
  });
  return { start: Math.max(0, start), end: Math.min(24 * 60, end) };
}

function renderDailyTimeline(date = todayISO()) {
  const el = $("daily-timeline");
  if (!el) return;
  const d = getData();
  const isToday = date === todayISO();
  const blocks = buildTimelineBlocks(d, date);
  const { start, end } = timelineBounds(blocks);
  const px = (min) => ((min - start) / SLOT_MINUTES) * SLOT_PX;

  // Active drivers, plus anyone (even inactive/unknown) who still has trips today.
  const columns = d.drivers.filter((dr) => dr.active !== false || blocks.some((b) => b.driverId === dr.id)).map((dr) => ({ ...dr }));
  blocks.forEach((b) => {
    if (!columns.some((c) => c.id === b.driverId)) columns.push({ ...UNKNOWN_DRIVER, id: b.driverId });
  });

  const totalHeight = ((end - start) / SLOT_MINUTES) * SLOT_PX;
  let html = `<div class="timeline-grid" style="--driver-count:${Math.max(columns.length, 1)};--slot-px:${SLOT_PX}px"><div class="timeline-corner" style="grid-row:1;grid-column:1">TIME</div>`;

  columns.forEach((dr, i) => {
    html += `<div class="timeline-driver-head" style="grid-row:1;grid-column:${i + 2}"><strong>${esc(dr.name)}</strong><span>${isWorkingOn(dr, date) ? "WORKING" : "OFF"}${isToday ? " TODAY" : ""}</span></div>`;
  });

  html += `<div class="timeline-times" style="grid-row:2;grid-column:1;height:${totalHeight}px">`;
  for (let m = start; m < end; m += SLOT_MINUTES) {
    html += `<div class="timeline-time">${formatTime(minutesToTime(m))}</div>`;
  }
  html += `</div>`;

  columns.forEach((dr, i) => {
    html += `<div class="timeline-col" style="grid-row:2;grid-column:${i + 2};height:${totalHeight}px">`;
    assignLanes(blocks.filter((b) => b.driverId === dr.id)).forEach((b) => {
      const p = getPatient(d, b.patientId);
      const top = px(b.start);
      const height = Math.max(26, px(Math.min(b.end, end)) - top - 2);
      const left = (b.lane / b.lanes) * 100;
      const width = 100 / b.lanes;
      html += `<a class="trip-block ${blockColorClass(b.status)}" href="/appointment/${encodeURIComponent(b.appointmentId)}" style="top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px)"><strong>${esc(p.name)}</strong><span>${formatTime(b.pickupTime)} · ${esc(b.direction)}</span><small>${statusLabel(b.status)} · ${b.durationMinutes} min</small></a>`;
    });
    html += `</div>`;
  });

  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  html += `<div class="timeline-overlay" style="grid-row:2;grid-column:1 / -1">`;
  if (isToday && current >= start && current <= end) {
    html += `<div class="current-time-line" style="top:${px(current)}px"><span>${formatTime(minutesToTime(current))}</span></div>`;
  }
  html += `</div></div>`;
  el.innerHTML = html;
}

let viewedDate = null; // null means "follow the real current day"

function currentViewDate() {
  return viewedDate || todayISO();
}
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localISO(d);
}
function isValidISODate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && !Number.isNaN(new Date(`${value}T12:00:00`).getTime());
}
function daysFromToday(iso) {
  return Math.round((new Date(`${iso}T12:00:00`) - new Date(`${todayISO()}T12:00:00`)) / 86400000);
}
function dayTitle(iso) {
  const diff = daysFromToday(iso);
  if (diff === 0) return "TODAY";
  if (diff === 1) return "TOMORROW";
  if (diff === -1) return "YESTERDAY";
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" }).toUpperCase();
}
function dayNote(iso) {
  const diff = daysFromToday(iso);
  if (diff > 1) return ` · ${diff} days ahead`;
  if (diff < -1) return ` · ${-diff} days ago (record)`;
  if (diff === -1) return " · record";
  return "";
}

function setViewedDate(iso) {
  viewedDate = iso === todayISO() ? null : iso;
  try {
    const url = new URL(location.href);
    if (viewedDate) url.searchParams.set("date", viewedDate);
    else url.searchParams.delete("date");
    history.replaceState(null, "", url);
  } catch (err) {
    console.warn(err);
  }
  refreshToday();
}
function shiftDay(n) {
  setViewedDate(addDays(currentViewDate(), n));
}
function goToToday() {
  setViewedDate(todayISO());
}
function pickDay(value) {
  if (isValidISODate(value)) setViewedDate(value);
}

// Left/right arrow keys move one day, unless the person is typing or a dialog is open.
function onTodayKeydown(e) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
  if (!$("warning-modal").classList.contains("hidden")) return;
  e.preventDefault();
  shiftDay(e.key === "ArrowRight" ? 1 : -1);
}

function refreshToday() {
  const d = getData();
  const date = currentViewDate();
  const isToday = date === todayISO();
  const trips = allTrips(d).filter((t) => t.date === date).sort(byPickupTime);
  const activeCount = trips.filter(isActiveTrip).length;
  const canceledCount = trips.length - activeCount;

  $("today-title").textContent = dayTitle(date);
  $("today-date").textContent = formatDate(date) + dayNote(date);
  $("today-count").textContent = plural(activeCount, "trip") + (canceledCount ? ` · ${canceledCount} canceled` : "");
  $("today-list-title").textContent = isToday ? "Today's Trips" : `Trips for ${formatShortDate(date)}`;
  $("today-jump").disabled = isToday;
  $("new-appt-link").href = isToday ? "/appointment/new" : `/appointment/new?date=${date}`;
  const picker = $("day-picker");
  if (picker.value !== date) picker.value = date;

  const header = `<div class="schedule-row header"><div>PICKUP</div><div>PATIENT</div><div>APPOINTMENT</div><div>DRIVER</div><div>DESTINATION</div><div></div></div>`;
  const rows = trips
    .map((t) => {
      const p = getPatient(d, t.patientId);
      const dr = getDriver(d, t.driverId);
      return `<a class="schedule-row ${isActiveTrip(t) ? "" : "is-canceled"}" href="/appointment/${encodeURIComponent(t.appointmentId)}"><div class="time">${formatTime(t.pickupTime)}</div><div><div class="patient-name">${esc(p.name)}</div><div class="secondary-line">${esc(t.direction)} trip · ${statusLabel(t.status)}</div></div><div>${formatTime(t.medicalAppointmentTime)}<div class="secondary-line">${esc(t.appointmentType)}</div></div><div>${esc(dr.name)}</div><div>${esc(firstLine(t.destination))}<div class="secondary-line">${esc(p.mobility)} · ${esc(p.vehicleRequirement)}</div></div><div class="chevron">›</div></a>`;
    })
    .join("");
  $("today-schedule").innerHTML = trips.length ? header + rows : `<p class="muted">No trips scheduled for ${isToday ? "today" : "this day"}.</p>`;
  renderDailyTimeline(date);
}

function renderToday() {
  initNav();
  const requested = new URLSearchParams(location.search).get("date");
  viewedDate = isValidISODate(requested) && requested !== todayISO() ? requested : null;
  pageRefresh = refreshToday;
  refreshToday();
  if (!window.cmhTodayTimer) window.cmhTodayTimer = setInterval(refreshToday, 60000);
  document.addEventListener("keydown", onTodayKeydown);
}

/* --------------------------------------------------------------------------
   Calendar
   -------------------------------------------------------------------------- */

let calendarDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedCalendarDate = todayISO();

function initCalendar() {
  initNav();
  pageRefresh = renderCalendar;
  renderCalendar();
}
function changeMonth(n) {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + n, 1);
  renderCalendar();
}
function selectCalendarDate(iso) {
  selectedCalendarDate = iso;
  const d = new Date(`${iso}T12:00:00`);
  calendarDate = new Date(d.getFullYear(), d.getMonth(), 1);
  renderCalendar();
}

function renderCalendar() {
  const d = getData();
  const y = calendarDate.getFullYear();
  const m = calendarDate.getMonth();
  const startOffset = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrev = new Date(y, m, 0).getDate();

  const counts = {};
  allTrips(d).filter(isActiveTrip).forEach((t) => (counts[t.date] = (counts[t.date] || 0) + 1));

  $("calendar-month").textContent = calendarDate.toLocaleDateString(undefined, { month: "long", year: "numeric" }).toUpperCase();
  let html = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((x) => `<div class="calendar-head">${x}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const n = i - startOffset + 1;
    let dt;
    let other = false;
    if (n < 1) {
      dt = new Date(y, m - 1, daysInPrev + n);
      other = true;
    } else if (n > daysInMonth) {
      dt = new Date(y, m + 1, n - daysInMonth);
      other = true;
    } else {
      dt = new Date(y, m, n);
    }
    const iso = localISO(dt);
    const count = counts[iso] || 0;
    html += `<button type="button" class="calendar-cell ${other ? "other-month" : ""} ${iso === selectedCalendarDate ? "selected" : ""}" onclick="selectCalendarDate('${iso}')"><div class="calendar-day-number">${dt.getDate()}</div>${count ? `<div class="calendar-dot">${plural(count, "trip")}</div>` : ""}</button>`;
  }
  $("calendar-grid").innerHTML = html;
  renderCalendarTrips();
}

function renderCalendarTrips() {
  const d = getData();
  const trips = allTrips(d).filter((t) => t.date === selectedCalendarDate).sort(byPickupTime);
  $("selected-date-title").textContent = formatDate(selectedCalendarDate);
  $("selected-date-count").textContent = plural(trips.length, "trip");
  $("selected-date-link").href = selectedCalendarDate === todayISO() ? "/" : `/?date=${selectedCalendarDate}`;
  $("calendar-trips").innerHTML = trips.length
    ? trips
        .map((t) => {
          const p = getPatient(d, t.patientId);
          const dr = getDriver(d, t.driverId);
          return `<a class="schedule-row ${isActiveTrip(t) ? "" : "is-canceled"}" href="/appointment/${encodeURIComponent(t.appointmentId)}"><div class="time">${formatTime(t.pickupTime)}</div><div><div class="patient-name">${esc(p.name)}</div><div class="secondary-line">${esc(t.direction)} · ${statusLabel(t.status)}</div></div><div>${formatTime(t.medicalAppointmentTime)}</div><div>${esc(dr.name)}</div><div>${esc(firstLine(t.destination))}</div><div class="chevron">›</div></a>`;
        })
        .join("")
    : `<p class="muted">No trips scheduled for this date.</p>`;
}

/* --------------------------------------------------------------------------
   Patients
   -------------------------------------------------------------------------- */

function showPatientForm() {
  $("new-patient-card")?.classList.remove("hidden");
  const form = $("patient-form");
  if (form) form.onsubmit = saveNewPatient;
}
function hidePatientForm() {
  $("new-patient-card")?.classList.add("hidden");
}

// Accepts "street, city, ST 12345" on one line or street / city-state-zip on two lines.
function checkAddressFormat(value) {
  const v = String(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(", ");
  return /^\d+\s+[^,]+(,\s*[^,]+)+,\s*[A-Za-z]{2}\s+\d{5}(-\d{4})?$/.test(v);
}

function updateAddressCheck() {
  const el = $("address-check");
  const value = $("patient-address")?.value || "";
  if (!el) return;
  if (!value.trim()) {
    el.textContent = "";
    return;
  }
  const ok = checkAddressFormat(value);
  el.textContent = ok ? "Address format looks complete. The demo does not contact an outside address service." : "Please use: street, city, state ZIP. Example: 123 Main Street, Lexington, KY 40508.";
  el.className = "small-note " + (ok ? "address-ok" : "address-warning");
}

async function saveNewPatient(e) {
  e.preventDefault();
  const d = getData();
  const first = $("patient-first").value.trim();
  const last = $("patient-last").value.trim();
  const address = $("patient-address").value.trim();
  const mobility = $("patient-mobility").value;
  const chairWidth = Number($("patient-chair-width").value) || null;

  if (["Wheelchair", "Power Wheelchair"].includes(mobility) && !chairWidth) {
    alert("Please enter the wheelchair width for wheelchair patients.");
    $("patient-chair-width").focus();
    return;
  }
  if (!checkAddressFormat(address) && !confirm("The address format could not be confirmed. Save it anyway?")) return;

  const id = "p" + Date.now();
  d.patients.push({
    id,
    name: `${first} ${last}`,
    dob: $("patient-dob").value,
    phone: $("patient-phone").value.trim(),
    address,
    mobility,
    chairWidth,
    vehicleRequirement: $("patient-vehicle").value,
    notes: $("patient-notes").value.trim(),
  });
  if (await saveData(d)) location.href = `/patient/${encodeURIComponent(id)}`;
}

function initPatients() {
  initNav();
  pageRefresh = renderPatients;
  const address = $("patient-address");
  if (address) address.oninput = updateAddressCheck;
  if (location.pathname === "/patient/new") showPatientForm();
  renderPatients();
}

function renderPatients() {
  const d = getData();
  const q = ($("patient-search")?.value || "").toLowerCase();
  const list = d.patients
    .filter((p) => `${p.name} ${p.phone} ${p.address}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  $("patient-list").innerHTML =
    list
      .map((p) => `<a class="patient-row" href="/patient/${encodeURIComponent(p.id)}"><div class="patient-row-main"><strong>${esc(p.name)}</strong><span>${esc(firstLine(p.address))} · ${esc(p.phone)}</span></div><span class="chevron">›</span></a>`)
      .join("") || `<p class="muted">No patients found.</p>`;
}

function detailItem(label, valueHtml, fullWidth = false) {
  return `<div class="detail-item"${fullWidth ? ' style="grid-column:1/-1"' : ""}><div class="detail-label">${label}</div><div class="detail-value">${valueHtml}</div></div>`;
}

function renderPatientDetail(id) {
  initNav();
  pageRefresh = () => renderPatientDetail(id);
  const d = getData();
  const p = findPatient(d, id);
  const target = $("patient-detail");
  if (!p) {
    target.innerHTML = `<section class="card"><h1>Patient not found</h1><p class="muted">This patient does not exist (the demo data may have been reset).</p></section>`;
    return;
  }
  const trips = allTrips(d)
    .filter((t) => t.patientId === id)
    .sort((a, b) => `${b.date}${b.pickupTime}`.localeCompare(`${a.date}${a.pickupTime}`));

  const history = trips.length
    ? trips
        .map((t) => {
          const dr = getDriver(d, t.driverId);
          return `<div class="trip-card"><div class="trip-card-head"><div><h3>${formatShortDate(t.date)} · ${esc(t.direction)}</h3><div class="secondary-line">${formatTime(t.pickupTime)} · ${esc(dr.name)}</div></div><span class="status ${statusClass(t.status)}">${statusLabel(t.status).toUpperCase()}</span></div><div class="trip-meta"><div><span>Pickup</span>${esc(firstLine(t.pickupAddress))}</div><div><span>Destination</span>${esc(firstLine(t.destination))}</div><div><span>Appointment</span>${formatTime(t.medicalAppointmentTime)}</div></div></div>`;
        })
        .join("")
    : `<p class="muted">No transportation history.</p>`;

  target.innerHTML = `<section class="card"><div class="detail-header"><div><h1>${esc(p.name)}</h1><p class="muted">Patient transportation profile</p></div><button class="button primary" onclick="alert('Patient editing can be added next.')">EDIT PATIENT</button></div><div class="detail-grid">${detailItem("Date of Birth", esc(p.dob))}${detailItem("Phone", esc(p.phone))}${detailItem("Mobility Equipment", esc(p.mobility))}${detailItem("Wheelchair Width", p.chairWidth ? `${esc(p.chairWidth)}"` : "Not applicable")}${detailItem("Vehicle Requirement", esc(p.vehicleRequirement))}${detailItem("Address", escLines(p.address))}${detailItem("Patient Notes", esc(p.notes || "None"), true)}</div></section><section class="card"><h2>Transportation History</h2>${history}</section>`;
}

/* --------------------------------------------------------------------------
   New appointment form
   -------------------------------------------------------------------------- */

const formState = { oneWay: false };

function buildFiveMinuteTimeOptions(startHour = 0, endHour = 24) {
  const options = [];

  for (let total = startHour * 60; total < endHour * 60; total += 5) {
    const value = minutesToTime(total);
    options.push(`<option value="${value}">${formatTime(value)}</option>`);
  }

  return options.join("");
}

function populateTimeOptions() {
  ["medical-time", "outbound-pickup"].forEach((id) => {
    const el = $(id);
    if (!el) return;

    const current = el.value;
    el.innerHTML = buildFiveMinuteTimeOptions(0, 24);

    if (current) {
      el.value = current;
    }
  });
}

function chooseTimeOption(selectId, totalMinutes) {
  const select = $(selectId);
  if (!select) return;

  const value = minutesToTime(totalMinutes);

  if ([...select.options].some((option) => option.value === value)) {
    select.value = value;
  } else {
    select.value = "";
  }
}

function populateDurationOptions() {
  ["outbound-duration", "return-duration"].forEach((id) => {
    const el = $(id);
    if (!el) return;

    el.innerHTML = Array.from(
      { length: 12 },
      (_, i) => `<option value="${(i + 1) * 15}">${(i + 1) * 15} minutes</option>`
    ).join("");
  });
}

function initAppointmentForm() {
  initNav();

  const d = getData();
  const driverOptions =
    `<option value="">Select a driver</option>` +
    activeDrivers(d)
      .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`)
      .join("");

  $("patient-id").innerHTML =
    `<option value="">Select a patient</option>` +
    d.patients
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
      .join("");

  $("outbound-driver").innerHTML = driverOptions;

  populateTimeOptions();
  populateDurationOptions();

  const requestedDate = new URLSearchParams(location.search).get("date");
  $("appointment-date").value =
    isValidISODate(requestedDate) ? requestedDate : todayISO();

  $("medical-time").value = "08:30";
  $("outbound-duration").value = "45";
  $("one-way-trip").checked = false;

  applyDefaultPickup();

  updatePatientPreview();

  $("patient-id").addEventListener("change", updatePatientPreview);

  $("medical-time").addEventListener("change", applyDefaultPickup);
  $("outbound-duration").addEventListener("change", applyDefaultPickup);

  $("one-way-trip").addEventListener("change", (e) => {
    formState.oneWay = e.target.checked;
  });

  [
    "appointment-date",
    "medical-time",
    "outbound-driver",
    "outbound-pickup",
    "outbound-duration"
  ].forEach((id) => {
    $(id).addEventListener("input", updateConflictPreview);
    $(id).addEventListener("change", updateConflictPreview);
  });

  $("appointment-form").onsubmit = saveAppointmentFromForm;

  updateConflictPreview();
}

// The outbound pickup is always derived from the medical appointment
// time minus the estimated outbound trip duration.
function applyDefaultPickup() {
  const medical = minutes($("medical-time").value);
  const outDuration =
    Number($("outbound-duration").value) || DEFAULT_TRIP_MINUTES;

  if (Number.isNaN(medical)) return;

  chooseTimeOption("outbound-pickup", medical - outDuration);
}

function updatePatientPreview() {
  const d = getData();
  const p = findPatient(d, $("patient-id").value);
  const preview = $("patient-profile-preview");
  if (!p) {
    $("pickup-address").value = "";
    preview.textContent = "Select a patient to view their transportation requirements.";
    return;
  }
  $("pickup-address").value = p.address;
  preview.innerHTML = `<strong>${esc(p.mobility)}</strong> · ${esc(p.vehicleRequirement)} vehicle · Chair width: ${p.chairWidth ? `${esc(p.chairWidth)}"` : "N/A"}`;
}

// Two trips conflict when pickups are close together or their time windows overlap.
function timesConflict(startA, durationA, startB, durationB) {
  return Math.abs(startA - startB) <= CONFLICT_WINDOW_MINUTES || (startA < startB + durationB && startA + durationA > startB);
}

function findDriverConflicts(driverId, date, pickupTime, durationMinutes = DEFAULT_TRIP_MINUTES) {
  if (!driverId || !date || !pickupTime) return [];
  const start = minutes(pickupTime);
  return allTrips(getData()).filter((t) => t.driverId === driverId && t.date === date && isActiveTrip(t) && timesConflict(start, durationMinutes, minutes(t.pickupTime), t.durationMinutes));
}

function readFormTrips() {
  const date = $("appointment-date").value;

  const outbound = {
    side: "Outbound",
    date,
    driverId: $("outbound-driver").value,
    pickupTime: $("outbound-pickup").value,
    durationMinutes:
      Number($("outbound-duration").value) || DEFAULT_TRIP_MINUTES,
  };

  return [outbound];
}

function getFormWarnings() {
  const d = getData();
  const [outbound] = readFormTrips();
  const warnings = [];

  if (outbound.driverId && outbound.pickupTime && outbound.date) {
    const driver = getDriver(d, outbound.driverId);

    findDriverConflicts(
      outbound.driverId,
      outbound.date,
      outbound.pickupTime,
      outbound.durationMinutes
    ).forEach((c) => {
      const patient = getPatient(d, c.patientId);

      warnings.push({
        side: "Outbound",
        text: `${driver.name} already has the ${c.direction.toLowerCase()} trip for ${patient.name} at ${formatTime(c.pickupTime)} (${firstLine(c.destination)}).`
      });
    });

    if (!isWorkingOn(driver, outbound.date)) {
      warnings.push({
        side: "Outbound",
        text: `${driver.name} is not scheduled to work on ${formatShortDate(outbound.date)}.`
      });
    }
  }

  const medical = $("medical-time").value;

  if (
    outbound.pickupTime &&
    medical &&
    minutes(outbound.pickupTime) + outbound.durationMinutes > minutes(medical)
  ) {
    warnings.push({
      side: "Outbound",
      text: `Pickup at ${formatTime(outbound.pickupTime)} plus ${outbound.durationMinutes} minutes of travel arrives after the ${formatTime(medical)} medical appointment.`
    });
  }

  return warnings;
}

function validateAppointmentForm() {
  const out = $("outbound-pickup").value;
  const medical = $("medical-time").value;

  if (!$("patient-id").value) {
    return "Select a patient.";
  }

  if (!$("outbound-driver").value) {
    return "Select an outbound driver.";
  }

  if (!out) {
    return "Enter an outbound pickup time.";
  }

  if (minutes(out) >= minutes(medical)) {
    return "The outbound pickup must be before the medical appointment time.";
  }

  return null;
}

function buildAppointmentFromForm() {
  return makeAppointment(
    "a" + Date.now(),
    $("patient-id").value,
    $("appointment-date").value,
    $("outbound-pickup").value,
    $("medical-time").value,
    $("outbound-driver").value,
    $("outbound-duration").value,
    "",
    "",
    DEFAULT_TRIP_MINUTES,
    $("pickup-address").value,
    $("destination").value,
    $("trip-type").value,
    $("notes").value.trim(),
    $("one-way-trip").checked
  );
}

function updateConflictPreview() {
  const banner = $("form-conflict-preview");
  if (!banner) return;
  const n = getFormWarnings().length;
  if (!n) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  banner.innerHTML = `<strong>Scheduling ${n === 1 ? "warning" : "warnings"}:</strong> ${plural(n, "issue")} found with this assignment. You will be asked to confirm before saving.`;
}

function saveAppointmentFromForm(e) {
  e.preventDefault();
  const errorBox = $("form-error");
  const error = validateAppointmentForm();
  if (error) {
    errorBox.textContent = error;
    errorBox.classList.remove("hidden");
    errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  errorBox.classList.add("hidden");

  const appointment = buildAppointmentFromForm();
  const warnings = getFormWarnings();
  if (warnings.length) {
    showConflictModal(warnings, () => actuallySaveAppointment(appointment));
  } else {
    actuallySaveAppointment(appointment);
  }
}

async function actuallySaveAppointment(appointment) {
  const d = getData();
  d.appointments.push(appointment);
  if (await saveData(d)) location.href = "/appointment/" + encodeURIComponent(appointment.id);
}

function showConflictModal(warnings, onConfirm) {
  const modal = $("warning-modal");
  $("conflict-message").textContent = "Review the warnings below. These may be intentional, such as shared transportation or a multi-stop route.";
  $("conflict-list").innerHTML = warnings.map((w) => `<div class="conflict-item"><strong>${esc(w.side)}</strong> · ${esc(w.text)}</div>`).join("");
  const checkbox = $("conflict-confirm");
  const button = $("assign-anyway-button");
  checkbox.checked = false;
  button.disabled = true;
  checkbox.onchange = () => (button.disabled = !checkbox.checked);
  button.onclick = () => {
    closeConflictModal();
    onConfirm();
  };
  modal.classList.remove("hidden");
  checkbox.focus();
}

function closeConflictModal() {
  $("warning-modal")?.classList.add("hidden");
}

/* --------------------------------------------------------------------------
   Appointment detail
   -------------------------------------------------------------------------- */

function driverOptionsHtml(d, selectedId = "") {
  return (
    `<option value="">Select a driver</option>` +
    activeDrivers(d)
      .map(
        (dr) =>
          `<option value="${esc(dr.id)}" ${dr.id === selectedId ? "selected" : ""}>${esc(dr.name)}</option>`
      )
      .join("")
  );
}

function timeOptionsHtml(selected = "") {
  const current = selected || "";
  return (
    `<option value="">Select time</option>` +
    buildFiveMinuteTimeOptions(0, 24)
      .replace(`<option value="${current}">`, `<option value="${current}" selected>`)
  );
}

function durationOptionsHtml(selected = DEFAULT_TRIP_MINUTES) {
  return Array.from(
    { length: 12 },
    (_, i) => {
      const value = (i + 1) * 15;
      return `<option value="${value}" ${Number(selected) === value ? "selected" : ""}>${value} minutes</option>`;
    }
  ).join("");
}

function tripDetail(t, driver, patient, appointmentId, canDelete = false) {
  if (!t) return "";

  const hasSchedule = Boolean(t.pickupTime && t.driverId);

  if (!hasSchedule) {
    return `
      <div class="trip-card trip-card-empty">
        <div class="trip-card-head">
          <div>
            <h3>${esc(t.direction || "Return Trip")}</h3>
            <div class="secondary-line">Trip generated and waiting for scheduling.</div>
          </div>
          <span class="status not-ready">NOT ASSIGNED</span>
        </div>

        <div class="trip-edit-grid">
          <div>
            <label for="trip-time-${esc(t.id)}">Pickup Time</label>
            <select id="trip-time-${esc(t.id)}">
              ${timeOptionsHtml(t.pickupTime)}
            </select>
          </div>

          <div>
            <label for="trip-driver-${esc(t.id)}">Driver</label>
            <select id="trip-driver-${esc(t.id)}">
              ${driverOptionsHtml(getData(), t.driverId)}
            </select>
          </div>

          <div>
            <label for="trip-duration-${esc(t.id)}">Estimated Trip Time</label>
            <select id="trip-duration-${esc(t.id)}">
              ${durationOptionsHtml(t.durationMinutes)}
            </select>
          </div>
        </div>

        <div class="trip-meta">
          <div>
            <span>Pickup</span>
            ${escLines(t.pickupAddress || patient.address)}
          </div>
          <div>
            <span>Destination</span>
            ${escLines(t.destination || "")}
          </div>
          <div>
            <span>Patient Phone</span>
            ${esc(patient.phone)}
          </div>
        </div>

        <div class="trip-status-actions">
          <button
            class="button primary"
            onclick="saveTripAssignment('${esc(appointmentId)}','${esc(t.id)}')"
          >
            SAVE TRIP
          </button>

          ${
            canDelete
              ? `<button class="button danger" onclick="deleteTrip('${esc(appointmentId)}','${esc(t.id)}')">DELETE TRIP</button>`
              : ""
          }
        </div>
      </div>
    `;
  }

  const actions = isActiveTrip(t)
    ? `
      <div class="trip-status-actions">
        <button class="status-button status-not-ready" onclick="setTripStatus('${esc(t.id)}','not-ready')">
          NOT READY
        </button>

        <button class="status-button status-progress" onclick="setTripStatus('${esc(t.id)}','in-progress')">
          IN PROGRESS
        </button>

        <button class="status-button status-ready" onclick="setTripStatus('${esc(t.id)}','ready')">
          READY FOR PICKUP
        </button>

        <button class="status-button status-complete" onclick="setTripStatus('${esc(t.id)}','completed')">
          COMPLETED
        </button>

        ${
          canDelete
            ? `<button class="status-button status-delete" onclick="deleteTrip('${esc(appointmentId)}','${esc(t.id)}')">DELETE TRIP</button>`
            : ""
        }
      </div>
    `
    : "";

  return `
    <div class="trip-card">
      <div class="trip-card-head">
        <div>
          <h3>${formatTime(t.pickupTime)} · ${esc(driver.name)}</h3>
          <div class="secondary-line">
            ${statusLabel(t.status)} · ${t.durationMinutes || DEFAULT_TRIP_MINUTES} minute estimated trip
          </div>
        </div>

        <span class="status ${statusClass(t.status)}">
          ${statusLabel(t.status).toUpperCase()}
        </span>
      </div>

      <div class="trip-meta">
        <div>
          <span>Pickup</span>
          ${escLines(t.pickupAddress)}
        </div>

        <div>
          <span>Destination</span>
          ${escLines(t.destination)}
        </div>

        <div>
          <span>Patient Phone</span>
          ${esc(patient.phone)}
        </div>
      </div>

      ${actions}
    </div>
  `;
}

function renderAppointmentDetail(id) {
  initNav();
  pageRefresh = () => renderAppointmentDetail(id);

  const d = getData();
  const a = d.appointments.find((x) => x.id === id);
  const target = $("appointment-detail");

  if (!a) {
    target.innerHTML = `
      <section class="card">
        <h1>Appointment not found</h1>
        <p class="muted">
          This appointment does not exist (the demo data may have been reset).
        </p>
      </section>
    `;
    return;
  }

  const p = getPatient(d, a.patientId);
  const allAppointmentTrips = [
    { ...(a.outbound || {}), direction: "Outbound" },
    ...(a.return ? [{ ...a.return, direction: "Return" }] : []),
    ...(a.additionalTrips || []).map((t, index) => ({
      ...t,
      direction: t.direction || `Additional Trip ${index + 1}`
    }))
  ];

  const canceled =
    allAppointmentTrips.length > 0 &&
    allAppointmentTrips.every((t) => !isActiveTrip(t));

  const buttons = canceled
    ? `<button class="button secondary" onclick="reinstateAppointment('${esc(a.id)}')">REINSTATE APPOINTMENT</button>`
    : `
      <button class="button secondary" onclick="editAppointment('${esc(a.id)}')">
        EDIT APPOINTMENT
      </button>

      <button class="button primary" onclick="showAddTripForm('${esc(a.id)}')">
        + ADD TRIP
      </button>

      <button class="button danger" onclick="showCancelAppointmentOptions('${esc(a.id)}')">
        CANCEL APPOINTMENT
      </button>
    `;

  const returnSection = a.oneWay
    ? `
      <h2 class="section-heading">Return Trip</h2>
      <div class="trip-card trip-card-empty">
        <h3>ONE-WAY TRANSPORTATION</h3>
        <p class="muted">
          No return trip will be generated for this appointment.
        </p>
      </div>
    `
    : a.return
      ? `
        <h2 class="section-heading">Return Trip</h2>
        ${tripDetail(
          a.return,
          getDriver(d, a.return.driverId),
          p,
          a.id,
          true
        )}
      `
      : `
        <h2 class="section-heading">Return Trip</h2>
        <div class="trip-card trip-card-empty">
          <h3>RETURN TRIP NOT YET GENERATED</h3>
          <p class="muted">
            When the outbound trip is marked <strong>READY FOR PICKUP</strong>,
            the return trip will be generated here for Ben to schedule.
          </p>
        </div>
      `;

  const additionalSections = (a.additionalTrips || [])
    .map((t, index) => `
      <h2 class="section-heading">${esc(t.direction || `Additional Trip ${index + 1}`)}</h2>
      ${tripDetail(t, getDriver(d, t.driverId), p, a.id, true)}
    `)
    .join("");

  target.innerHTML = `
    <section class="card">

      <div class="detail-header">
        <div>
          <h1>${esc(p.name)}</h1>
          <p class="muted">
            ${formatShortDate(a.date)} · ${esc(a.type)}
          </p>
        </div>

        <span class="status ${canceled ? "canceled" : "scheduled"}">
          ${canceled ? "CANCELED" : "TRANSPORTATION APPOINTMENT"}
        </span>
      </div>

      <div class="detail-grid">
        ${detailItem("Medical Appointment", formatTime(a.medicalAppointmentTime))}
        ${detailItem("Patient Phone", esc(p.phone))}
        ${detailItem("Mobility Equipment", esc(p.mobility))}
        ${detailItem("Vehicle Requirement", esc(p.vehicleRequirement))}
        ${detailItem("Wheelchair Width", p.chairWidth ? `${esc(p.chairWidth)}"` : "Not applicable")}
        ${detailItem("Patient Notes", esc(p.notes || "None"))}
        ${detailItem("Trip Notes", escLines(a.notes || "None"), true)}
      </div>

      <h2 class="section-heading">Outbound Trip</h2>
      ${tripDetail(a.outbound, getDriver(d, a.outbound.driverId), p, a.id, false)}

      ${returnSection}

      ${additionalSections}

      <div id="edit-appointment-form-container"></div>
      <div id="add-trip-form-container"></div>
      <div id="cancel-appointment-container"></div>

      <div class="form-actions">
        ${buttons}
      </div>

    </section>
  `;
}


function editAppointment(appointmentId) {
  const d = getData();
  const a = d.appointments.find((x) => x.id === appointmentId);
  const container = $("edit-appointment-form-container");
  if (!a || !container) return;

  const outbound = a.outbound || {};

  container.innerHTML = `
    <div class="trip-card add-trip-panel appointment-edit-panel">
      <div class="trip-card-head">
        <div>
          <h3>EDIT TRANSPORTATION APPOINTMENT</h3>
          <p class="muted">Change the appointment information or outbound trip. Pickup time automatically follows appointment time minus estimated trip time.</p>
        </div>
      </div>

      <div class="trip-edit-grid">
        <div>
          <label for="edit-appointment-date">Date</label>
          <input id="edit-appointment-date" type="date" value="${esc(a.date)}">
        </div>

        <div>
          <label for="edit-medical-time">Medical Appointment Time</label>
          <select id="edit-medical-time">${timeOptionsHtml(a.medicalAppointmentTime)}</select>
        </div>

        <div>
          <label for="edit-trip-type">Appointment Type</label>
          <select id="edit-trip-type">
            ${[
              "Doctor Appointment",
              "Therapy",
              "Dialysis",
              "Procedure",
              "Facility Transfer",
              "Other"
            ].map((type) => `<option value="${esc(type)}" ${a.type === type ? "selected" : ""}>${esc(type)}</option>`).join("")}
          </select>
        </div>

        <div>
          <label for="edit-outbound-pickup">Outbound Pickup Time</label>
          <select id="edit-outbound-pickup">${timeOptionsHtml(outbound.pickupTime)}</select>
        </div>

        <div>
          <label for="edit-outbound-driver">Outbound Driver</label>
          <select id="edit-outbound-driver">${driverOptionsHtml(d, outbound.driverId)}</select>
        </div>

        <div>
          <label for="edit-outbound-duration">Estimated Trip Time</label>
          <select id="edit-outbound-duration">${durationOptionsHtml(outbound.durationMinutes)}</select>
        </div>

        <div>
          <label for="edit-pickup-address">Pickup Address</label>
          <textarea id="edit-pickup-address" rows="3">${esc(outbound.pickupAddress || "")}</textarea>
        </div>

        <div>
          <label for="edit-destination">Destination</label>
          <textarea id="edit-destination" rows="3">${esc(outbound.destination || "")}</textarea>
        </div>

        <div>
          <label for="edit-one-way">Trip Type</label>
          <label class="confirm-row edit-one-way-row">
            <input type="checkbox" id="edit-one-way" ${a.oneWay ? "checked" : ""}>
            <span>One-way trip — do not generate a return trip.</span>
          </label>
        </div>

        <div class="full-width">
          <label for="edit-notes">Appointment Notes</label>
          <textarea id="edit-notes" rows="3">${esc(a.notes || "")}</textarea>
        </div>
      </div>

      <div class="form-actions">
        <button class="button secondary" type="button" onclick="cancelEditAppointment()">CANCEL EDIT</button>
        <button class="button primary" type="button" onclick="saveAppointmentEdits('${esc(appointmentId)}')">SAVE APPOINTMENT</button>
      </div>
    </div>
  `;

  $("edit-medical-time").addEventListener("change", updateEditedOutboundPickup);
  $("edit-outbound-duration").addEventListener("change", updateEditedOutboundPickup);

  container.scrollIntoView({ behavior: "smooth", block: "center" });
}

function updateEditedOutboundPickup() {
  const medical = minutes($("edit-medical-time").value);
  const duration = Number($("edit-outbound-duration").value) || DEFAULT_TRIP_MINUTES;
  if (Number.isNaN(medical)) return;
  const pickup = minutesToTime(medical - duration);
  const select = $("edit-outbound-pickup");
  if (select && [...select.options].some((option) => option.value === pickup)) {
    select.value = pickup;
  }
}

function cancelEditAppointment() {
  const container = $("edit-appointment-form-container");
  if (container) container.innerHTML = "";
}

async function saveAppointmentEdits(appointmentId) {
  const d = getData();
  const a = d.appointments.find((x) => x.id === appointmentId);
  if (!a) return;

  const date = $("edit-appointment-date").value;
  const medicalTime = $("edit-medical-time").value;
  const pickupTime = $("edit-outbound-pickup").value;
  const driverId = $("edit-outbound-driver").value;
  const durationMinutes = Number($("edit-outbound-duration").value) || DEFAULT_TRIP_MINUTES;
  const pickupAddress = $("edit-pickup-address").value.trim();
  const destination = $("edit-destination").value.trim();
  const oneWay = $("edit-one-way").checked;

  if (!date || !medicalTime || !pickupTime || !driverId || !pickupAddress || !destination) {
    alert("Complete the date, appointment time, pickup time, driver, pickup address, and destination.");
    return;
  }

  if (minutes(pickupTime) >= minutes(medicalTime)) {
    alert("The outbound pickup must be before the medical appointment time.");
    return;
  }

  a.date = date;
  a.medicalAppointmentTime = medicalTime;
  a.type = $("edit-trip-type").value;
  a.notes = $("edit-notes").value.trim();
  a.oneWay = oneWay;

  a.outbound.pickupTime = pickupTime;
  a.outbound.driverId = driverId;
  a.outbound.durationMinutes = durationMinutes;
  a.outbound.pickupAddress = pickupAddress;
  a.outbound.destination = destination;

  if (oneWay) {
    a.return = null;
  } else if (a.return) {
    a.return.pickupAddress = destination;
    a.return.destination = pickupAddress;
  }

  if (await saveData(d)) {
    renderAppointmentDetail(appointmentId);
  }
}

function showCancelAppointmentOptions(appointmentId) {
  const container = $("cancel-appointment-container");
  if (!container) return;

  container.innerHTML = `
    <div class="trip-card cancel-panel">
      <h3>CANCEL TRANSPORTATION APPOINTMENT</h3>
      <p class="muted">The appointment will remain visible in the patient's history for billing and records.</p>
      <div class="cancel-choice-actions">
        <button class="button danger" type="button" onclick="cancelAppointment('${esc(appointmentId)}','canceled')">CANCELED</button>
        <button class="button danger" type="button" onclick="cancelAppointment('${esc(appointmentId)}','caa')">CAA — CANCELLATION AFTER ARRIVAL</button>
        <button class="button secondary" type="button" onclick="cancelCancelPanel()">GO BACK</button>
      </div>
    </div>
  `;

  container.scrollIntoView({ behavior: "smooth", block: "center" });
}

function cancelCancelPanel() {
  const container = $("cancel-appointment-container");
  if (container) container.innerHTML = "";
}

function ensureReturnTrip(a) {
  if (!a || a.oneWay || a.return) return false;

  const out = a.outbound;

  a.return = {
    id: a.id + "-return",
    pickupTime: "",
    driverId: "",
    durationMinutes: DEFAULT_TRIP_MINUTES,
    pickupAddress: out.destination || "",
    destination: out.pickupAddress || "",
    status: "not-ready",
    notes: ""
  };

  return true;
}

async function setTripStatus(tripId, status) {
  const d = getData();

  for (const a of d.appointments) {
    const trip = [
      a.outbound,
      a.return,
      ...(a.additionalTrips || [])
    ].find((t) => t && t.id === tripId);

    if (!trip) continue;
    if (!isActiveTrip(trip)) return;

    trip.status = status;

    let changed = true;

    // Yellow / Ready for Pickup on the outbound trip is the trigger
    // for generating the return trip, unless this is a one-way appointment.
    if (
      trip.id === a.outbound.id &&
      status === "ready" &&
      !a.oneWay &&
      !a.return
    ) {
      changed = ensureReturnTrip(a) || changed;
    }

    if (changed && await saveData(d)) {
      renderAppointmentDetail(a.id);
    }

    return;
  }
}

function showAddTripForm(appointmentId) {
  const container = $("add-trip-form-container");
  if (!container) return;

  const d = getData();
  const a = d.appointments.find((x) => x.id === appointmentId);
  if (!a) return;

  container.innerHTML = `
    <div class="trip-card add-trip-panel">
      <div class="trip-card-head">
        <div>
          <h3>ADD TRIP</h3>
          <p class="muted">
            Add another transportation leg for organization and invoicing.
          </p>
        </div>
      </div>

      <div class="trip-edit-grid">
        <div>
          <label for="add-trip-direction">Trip Name</label>
          <input
            id="add-trip-direction"
            type="text"
            value="Additional Trip"
            placeholder="Hospital, another office, etc."
          >
        </div>

        <div>
          <label for="add-trip-time">Pickup Time</label>
          <select id="add-trip-time">
            ${timeOptionsHtml("")}
          </select>
        </div>

        <div>
          <label for="add-trip-driver">Driver</label>
          <select id="add-trip-driver">
            ${driverOptionsHtml(d, "")}
          </select>
        </div>

        <div>
          <label for="add-trip-duration">Estimated Trip Time</label>
          <select id="add-trip-duration">
            ${durationOptionsHtml(DEFAULT_TRIP_MINUTES)}
          </select>
        </div>

        <div>
          <label for="add-trip-pickup-address">Pickup Address</label>
          <textarea id="add-trip-pickup-address" rows="3">${esc(
            a.additionalTrips?.length
              ? a.additionalTrips[a.additionalTrips.length - 1].destination || ""
              : a.outbound.destination || ""
          )}</textarea>
        </div>

        <div>
          <label for="add-trip-destination">Destination</label>
          <textarea id="add-trip-destination" rows="3"></textarea>
        </div>
      </div>

      <div class="form-actions">
        <button class="button secondary" onclick="cancelAddTripForm()">
          CANCEL
        </button>

        <button class="button primary" onclick="saveAdditionalTrip('${esc(appointmentId)}')">
          ADD TRIP
        </button>
      </div>
    </div>
  `;

  container.scrollIntoView({ behavior: "smooth", block: "center" });
}

function cancelAddTripForm() {
  const container = $("add-trip-form-container");
  if (container) container.innerHTML = "";
}

async function saveAdditionalTrip(appointmentId) {
  const d = getData();
  const a = d.appointments.find((x) => x.id === appointmentId);
  if (!a) return;

  const pickupTime = $("add-trip-time").value;
  const driverId = $("add-trip-driver").value;
  const durationMinutes =
    Number($("add-trip-duration").value) || DEFAULT_TRIP_MINUTES;
  const pickupAddress = $("add-trip-pickup-address").value.trim();
  const destination = $("add-trip-destination").value.trim();
  const direction =
    $("add-trip-direction").value.trim() || "Additional Trip";

  if (!pickupTime || !driverId || !pickupAddress || !destination) {
    alert("Enter a pickup time, driver, pickup address, and destination.");
    return;
  }

  if (!Array.isArray(a.additionalTrips)) {
    a.additionalTrips = [];
  }

  a.additionalTrips.push({
    id: `${a.id}-trip-${Date.now()}`,
    pickupTime,
    driverId,
    durationMinutes,
    pickupAddress,
    destination,
    status: "not-ready",
    notes: "",
    direction
  });

  if (await saveData(d)) {
    renderAppointmentDetail(appointmentId);
  }
}

async function saveTripAssignment(appointmentId, tripId) {
  const d = getData();
  const a = d.appointments.find((x) => x.id === appointmentId);
  if (!a) return;

  const trip = [
    a.return,
    ...(a.additionalTrips || [])
  ].find((t) => t && t.id === tripId);

  if (!trip) return;

  const time = $(`trip-time-${tripId}`).value;
  const driverId = $(`trip-driver-${tripId}`).value;
  const duration = Number($(`trip-duration-${tripId}`).value) || DEFAULT_TRIP_MINUTES;

  if (!time || !driverId) {
    alert("Select a pickup time and driver.");
    return;
  }

  trip.pickupTime = time;
  trip.driverId = driverId;
  trip.durationMinutes = duration;

  if (await saveData(d)) {
    renderAppointmentDetail(appointmentId);
  }
}

async function deleteTrip(appointmentId, tripId) {
  const d = getData();
  const a = d.appointments.find((x) => x.id === appointmentId);
  if (!a) return;

  if (a.outbound?.id === tripId) {
    alert("The primary outbound trip cannot be deleted. Cancel the transportation appointment instead.");
    return;
  }

  if (a.return?.id === tripId) {
    if (!confirm("Delete this return trip? It can be generated again later if needed.")) return;
    a.return = null;
  } else {
    const index = (a.additionalTrips || []).findIndex((t) => t.id === tripId);
    if (index === -1) return;

    if (!confirm("Delete this trip? This removes it from the appointment and driver schedule.")) return;

    a.additionalTrips.splice(index, 1);
  }

  if (await saveData(d)) {
    renderAppointmentDetail(appointmentId);
  }
}

async function cancelAppointment(id, requestedStatus = null) {
  const d = getData();
  const a = d.appointments.find((x) => x.id === id);
  if (!a) return;

  let value = requestedStatus;

  if (!value) {
    const answer = prompt(
      'Type "CANCELED" or "CAA" to cancel this appointment. It will stay visible for history.',
      "CANCELED"
    );
    if (answer === null) return;
    value = answer.trim().toLowerCase();
  }

  if (value !== "canceled" && value !== "caa") {
    alert("Please choose CANCELED or CAA. Nothing was changed.");
    return;
  }

  const label = value === "caa" ? "CAA — Cancellation After Arrival" : "CANCELED";
  if (!confirm(`Mark this transportation appointment as ${label}? It will remain in history.`)) return;

  [a.outbound, a.return, ...(a.additionalTrips || [])]
    .filter(Boolean)
    .forEach((t) => {
      if (t.status !== "completed") {
        t.status = value;
      }
    });

  if (await saveData(d)) {
    renderAppointmentDetail(id);
  }
}

async function reinstateAppointment(id) {
  const d = getData();
  const a = d.appointments.find((x) => x.id === id);
  if (!a) return;

  [a.outbound, a.return, ...(a.additionalTrips || [])]
    .filter(Boolean)
    .forEach((t) => {
      if (!isActiveTrip(t)) {
        t.status = "not-ready";
      }
    });

  if (await saveData(d)) {
    renderAppointmentDetail(id);
  }
}

/* --------------------------------------------------------------------------
   Drivers
   -------------------------------------------------------------------------- */

function showDriverForm() {
  $("new-driver-card")?.classList.remove("hidden");
  const form = $("driver-form");
  if (form) form.onsubmit = saveNewDriver;
}
function hideDriverForm() {
  $("new-driver-card")?.classList.add("hidden");
  $("driver-form")?.reset();
}

async function saveNewDriver(e) {
  e.preventDefault();
  const d = getData();
  const name = $("driver-name").value.trim();
  const days = [...document.querySelectorAll(".work-day:checked")].map((x) => x.value);
  if (!name) return;
  if (!days.length) {
    alert("Select at least one normal work day.");
    return;
  }
  d.drivers.push({
    id: "d" + Date.now(),
    name,
    phone: $("driver-phone").value.trim(),
    title: $("driver-title").value.trim() || "Driver",
    active: $("driver-active").value === "true",
    workDays: days,
  });
  if (!(await saveData(d))) return;
  renderDrivers();
  hideDriverForm();
}

function renderDrivers() {
  initNav();
  pageRefresh = renderDrivers;
  const el = $("driver-list");
  if (!el) return;
  const d = getData();
  const dayLabels = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  const today = todayISO();
  el.innerHTML =
    d.drivers
      .map((dr) => {
        const working = isWorkingToday(dr);
        const assigned = allTrips(d).filter((t) => t.date === today && t.driverId === dr.id && isActiveTrip(t)).length;
        const days = (dr.workDays || []).map((x) => dayLabels[x] || x).join(", ") || "Not set";
        return `<div class="driver-card"><div><h2>${esc(dr.name)}</h2><p class="muted">${esc(dr.title || "Driver")} · ${esc(dr.phone || "No phone")}</p><div class="driver-tags"><span class="driver-status ${dr.active !== false ? "active" : "inactive"}">${dr.active !== false ? "ACTIVE" : "INACTIVE"}</span><span class="driver-status ${working ? "working" : "off"}">${working ? "WORKING TODAY" : "OFF TODAY"}</span></div></div><div><div class="secondary-line">Work days: ${esc(days)}</div><div class="secondary-line">Today: ${plural(assigned, "trip")}</div></div></div>`;
      })
      .join("") || '<div class="card"><p class="muted">No drivers added.</p></div>';
}

function renderDriverSchedule() {
  initNav();
  pageRefresh = renderDriverSchedule;
  const d = getData();
  const uid = currentUser();
  const dr = findDriver(d, uid);
  const schedule = $("driver-schedule");
  $("driver-date").textContent = formatDate(todayISO());

  if (!dr) {
    $("driver-heading").textContent = "MY SCHEDULE";
    schedule.innerHTML = `<p class="muted">You are viewing as a dispatcher. Choose a driver in the USER menu to see that driver's schedule.</p>`;
    return;
  }
  $("driver-heading").textContent = dr.name.toUpperCase() + "'S SCHEDULE";

  const trips = allTrips(d).filter((t) => t.date === todayISO() && t.driverId === dr.id && isActiveTrip(t)).sort(byPickupTime);
  schedule.innerHTML = trips.length
    ? trips
        .map((t) => {
          const p = getPatient(d, t.patientId);
          const notes = t.appointmentNotes ? `<div class="secondary-line"><strong>Notes:</strong> ${escLines(t.appointmentNotes)}</div>` : "";
          const patientNotes = p.notes ? `<div class="secondary-line"><strong>Patient notes:</strong> ${esc(p.notes)}</div>` : "";
          return `<div class="driver-trip ${esc(t.status)}"><div class="driver-trip-time">${formatTime(t.pickupTime)}</div><div><h3>${esc(p.name)}</h3><div class="secondary-line"><strong>${esc(t.direction)} trip</strong> · ${statusLabel(t.status)} · ${t.durationMinutes} min</div><div class="secondary-line"><strong>Pickup:</strong> ${escLines(t.pickupAddress)}</div><div class="secondary-line"><strong>Destination:</strong> ${escLines(t.destination)}</div><div class="secondary-line"><strong>Appointment:</strong> ${formatTime(t.medicalAppointmentTime)}</div><div class="secondary-line"><strong>Phone:</strong> ${esc(p.phone)}</div>${notes}${patientNotes}</div><div><span class="status ${statusClass(t.status)}">${statusLabel(t.status).toUpperCase()}</span><br><span class="warning-tag">${esc(p.mobility)} · ${esc(p.vehicleRequirement)}</span></div></div>`;
        })
        .join("")
    : `<p class="muted">No trips assigned to ${esc(dr.name)} today.</p>`;
}

/* --------------------------------------------------------------------------
   Global listeners
   -------------------------------------------------------------------------- */

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeConflictModal();
});
// Another browser tab saved something, or the page came back from the Back/Forward cache.
window.addEventListener("storage", (e) => {
  if (e.key === null) pageRefresh?.();
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) pageRefresh?.();
});
document.addEventListener("click", (e) => {
  if (e.target.id === "warning-modal") closeConflictModal();
});
