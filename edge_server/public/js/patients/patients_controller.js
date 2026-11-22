// =============================================================================
// SHIRO Dashboard - Patients
// The list of patients (admitted ones first, 8 a page), admitting, the profile,
// beds, vitals history. Phase 11: the admission form opens on demand; the fall
// risk score is no longer asked or shown (it changed nothing in the system; the
// database keeps the column).
// =============================================================================

let currentPatientFilter = 'ADMITTED';
let currentPatientPage = 1;
let cachedPatients = [];
// The wristband each patient wears now: patient_id -> binding (patient_wristbands.js)
let bindingByPatient = new Map();
let cachedWards = [];
let cachedAvailableBeds = [];

/**
 * Main initializer for the Patients module.
 */
async function initPatientsModule() {
  // Set max date for DOB to today
  const dobEl = document.getElementById('adm-dob');
  if (dobEl) {
    const today = new Date().toISOString().split('T')[0];
    dobEl.setAttribute('max', today);
  }

  await Promise.all([
    fetchNextPatientId(),
    fetchAvailableBedsAndWards(),
    loadPatientsDirectory()
  ]);
  handleNameOrDobChange();
}

/** Opens or closes the "Admit a patient" form above the list. */
function toggleAdmissionForm(open) {
  const card = document.getElementById('admission-card');
  if (!card) return;
  card.style.display = open ? 'block' : 'none';
  const btn = document.getElementById('btn-open-admission');
  if (btn) btn.style.display = open ? 'none' : '';
  if (open) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const name = document.getElementById('adm-name');
    if (name) setTimeout(() => name.focus(), 250);
  }
}

/**
 * Clears error state on an input field.
 */
function clearValidation(el) {
  if (!el) return;
  el.classList.remove('is-invalid');
  el.style.borderColor = '';
  el.style.backgroundColor = '';
  el.style.boxShadow = '';
  const feedback = el.parentElement.querySelector('.invalid-feedback') || document.getElementById(`err-${el.id}`);
  if (feedback) feedback.style.display = 'none';
}

/**
 * Sets validation error on a field with high-contrast red styling.
 */
function setValidationError(el, errorMsg) {
  if (!el) return;
  el.classList.add('is-invalid');
  el.style.borderColor = '#EF4444';
  el.style.backgroundColor = '#FEF2F2';
  el.style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.25)';
  const feedback = el.parentElement.querySelector('.invalid-feedback') || document.getElementById(`err-${el.id}`);
  if (feedback) {
    if (errorMsg) feedback.innerText = errorMsg;
    feedback.style.display = 'block';
    feedback.style.color = '#DC2626';
    feedback.style.fontWeight = '600';
  }
}

/**
 * Computes age in years from a YYYY-MM-DD date string.
 */
function calculateClientAge(dobStr) {
  if (!dobStr) return 0;
  const dob = new Date(dobStr);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) {
    age--;
  }
  return age >= 0 ? age : 0;
}

/**
 * Updates age badge and suggests avatar if default.
 */
function handleNameOrDobChange() {
  const dobEl = document.getElementById('adm-dob');
  const ageBadge = document.getElementById('adm-age-badge');
  const nricEl = document.getElementById('adm-nric');
  if (!dobEl || !ageBadge) return;

  if (!dobEl.value) {
    ageBadge.innerText = '--';
    return;
  }

  const age = calculateClientAge(dobEl.value);
  ageBadge.innerText = `${age} yrs`;

  // Cross-validate with NRIC if NRIC is entered
  if (nricEl && nricEl.value.trim()) {
    const cleanNric = nricEl.value.replace(/[-\s]/g, '');
    if (/^\d{6}/.test(cleanNric)) {
      const dobParts = dobEl.value.split('-');
      if (dobParts.length === 3) {
        const expectedPrefix = `${dobParts[0].substring(2)}${dobParts[1]}${dobParts[2]}`;
        const actualPrefix = cleanNric.substring(0, 6);
        if (actualPrefix !== expectedPrefix) {
          setValidationError(dobEl, `Date of Birth (${dobParts[0]}-${dobParts[1]}-${dobParts[2]}) does not match NRIC birthdate prefix (${actualPrefix}).`);
        } else {
          clearValidation(dobEl);
        }
      }
    }
  }
}

/**
 * Validates IC format and cross-validates against Date of Birth.
 * Prefix mismatch warning attaches to the Date of Birth field.
 */
function handleNricInput(el) {
  if (!el) return;
  const val = el.value.trim().replace(/\s/g, '');
  const dobEl = document.getElementById('adm-dob');

  // If 12 digit Malaysian IC without hyphens, auto-format to XXXXXX-XX-XXXX
  if (/^\d{12}$/.test(val)) {
    el.value = `${val.substring(0, 6)}-${val.substring(6, 8)}-${val.substring(8, 12)}`;
  }

  // Cross check with DOB if DOB is selected and NRIC looks like Malaysian IC
  const cleanVal = el.value.replace(/[-\s]/g, '');
  if (/^\d{6}/.test(cleanVal) && dobEl && dobEl.value) {
    const dobParts = dobEl.value.split('-'); // [YYYY, MM, DD]
    if (dobParts.length === 3) {
      const expectedPrefix = `${dobParts[0].substring(2)}${dobParts[1]}${dobParts[2]}`;
      const actualPrefix = cleanVal.substring(0, 6);
      if (actualPrefix !== expectedPrefix) {
        setValidationError(dobEl, `Date of Birth does not match NRIC birthdate prefix (${actualPrefix}).`);
        clearValidation(el);
        return;
      } else {
        clearValidation(dobEl);
        clearValidation(el);
      }
    }
  } else if (dobEl && !cleanVal) {
    clearValidation(dobEl);
  }
}

/**
 * When gender is changed, updates suggested default avatar if an avatar preset is active.
 */
function handleSexChange() {
  const sexEl = document.getElementById('adm-sex');
  const dobEl = document.getElementById('adm-dob');
  const photoUrlEl = document.getElementById('adm-photo-url');
  if (!sexEl || !photoUrlEl) return;

  const age = calculateClientAge(dobEl ? dobEl.value : null);
  const isElderly = age >= 60;
  const isFemale = sexEl.value === 'FEMALE';

  // Only auto-switch if currently using one of the standard presets
  if (photoUrlEl.value.includes('/uploads/patients/preset_')) {
    let target = '/uploads/patients/preset_adult_male.svg';
    if (isElderly && isFemale) target = '/uploads/patients/preset_elderly_female.svg';
    else if (isElderly && !isFemale) target = '/uploads/patients/preset_elderly_male.svg';
    else if (!isElderly && isFemale) target = '/uploads/patients/preset_adult_female.svg';
    else if (!isElderly && !isFemale) target = '/uploads/patients/preset_adult_male.svg';

    const btn = document.querySelector(`.preset-avatar-btn[onclick*="${target}"]`);
    selectAvatarPreset(target, btn);
  }
}

/**
 * Selects one of the 4 quick clinical avatar presets.
 */
function selectAvatarPreset(url, buttonEl) {
  const previewImg = document.getElementById('adm-photo-img');
  const photoUrlEl = document.getElementById('adm-photo-url');
  if (previewImg) previewImg.src = url;
  if (photoUrlEl) photoUrlEl.value = url;

  document.querySelectorAll('.preset-avatar-btn').forEach(b => b.classList.remove('active'));
  if (buttonEl) buttonEl.classList.add('active');
}

/**
 * Handles custom photo file upload via HTML file input.
 */
function handlePhotoFileUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  // The server stores PNG, JPEG and WebP only
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    if (window.showToast) window.showToast('Please select a JPG, PNG or WebP image.', 'warning');
    return;
  }

  if (file.size > 3 * 1024 * 1024) {
    if (window.showToast) window.showToast('Image file too large. Maximum size is 3MB.', 'warning');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = e.target.result;
    const previewImg = document.getElementById('adm-photo-img');
    const photoUrlEl = document.getElementById('adm-photo-url');
    if (previewImg) previewImg.src = dataUrl;
    if (photoUrlEl) photoUrlEl.value = dataUrl;

    document.querySelectorAll('.preset-avatar-btn').forEach(b => b.classList.remove('active'));
    if (window.showToast) window.showToast('Custom photo attached. Ready for admission.', 'info');
  };
  reader.readAsDataURL(file);
}

/**
 * Fetches the next sequential patient ID from backend.
 */
async function fetchNextPatientId() {
  try {
    const res = await fetch('/api/patients/next-id');
    const data = await res.json();
    if (data.success && data.nextId) {
      const idInput = document.getElementById('adm-id');
      const badge = document.getElementById('adm-next-id-badge');
      if (idInput) idInput.value = data.nextId;
      if (badge) badge.innerText = `ID: ${data.nextId}`;
      return data.nextId;
    }
  } catch (err) {
    console.error('Failed to fetch next patient ID:', err);
  }
  return 'P-001';
}

/**
 * Fetches wards and currently available beds from MySQL.
 */
async function fetchAvailableBedsAndWards() {
  try {
    const res = await fetch('/api/patients/available-beds');
    const data = await res.json();
    if (data.success) {
      cachedWards = data.wards || [];
      cachedAvailableBeds = data.availableBeds || [];
      populateWardDropdown();
      handleWardSelectionChange();
    }
  } catch (err) {
    console.error('Failed to fetch available beds and wards:', err);
  }
}

/**
 * Populates the Target Ward Unit dropdown (defaults to None / Unassigned).
 */
function populateWardDropdown() {
  const wardSelect = document.getElementById('adm-ward');
  if (!wardSelect) return;

  const currentVal = wardSelect.value;
  let optionsHtml = `<option value="">Not yet</option>`;

  if (cachedWards && cachedWards.length > 0) {
    optionsHtml += cachedWards.map(w => 
      `<option value="${escapeHtml(w.ward_id)}">${escapeHtml(w.ward_id)} - ${escapeHtml(w.room_title)}</option>`
    ).join('');
  }

  wardSelect.innerHTML = optionsHtml;

  if (currentVal && cachedWards.some(w => w.ward_id === currentVal)) {
    wardSelect.value = currentVal;
  } else {
    wardSelect.value = '';
  }
}

/**
 * When a ward is selected, dynamically populates the available beds dropdown.
 */
function handleWardSelectionChange() {
  const wardSelect = document.getElementById('adm-ward');
  const bedSelect = document.getElementById('adm-bed');
  if (!wardSelect || !bedSelect) return;

  const selectedWardId = wardSelect.value;
  if (!selectedWardId) {
    bedSelect.innerHTML = `<option value="">Not yet</option>`;
    bedSelect.disabled = true;
    return;
  }

  bedSelect.disabled = false;
  const available = cachedAvailableBeds.filter(b => b.ward_id === selectedWardId);

  if (available.length === 0) {
    bedSelect.innerHTML = `<option value="" disabled selected>⚠️ No available beds in this ward (All Occupied / Unavailable)</option>`;
  } else {
    bedSelect.innerHTML = available.map(b => 
      `<option value="${escapeHtml(b.bed_id)}">🟢 ${escapeHtml(b.bed_code)} (${escapeHtml(b.bed_id)}) - Available</option>`
    ).join('');
  }
}

/**
 * Loads the Inpatient Census Directory from MySQL.
 */
async function loadPatientsDirectory() {
  const tbody = document.getElementById('patients-table-body');
  if (!tbody) return;

  try {
    // Every patient once; the filter and the counts work on this list. And the wristbands they wear.
    const [res, bindingsRes] = await Promise.all([
      fetch('/api/patients/list?status=ALL'),
      fetch('/api/bindings/list').catch(() => null)
    ]);
    const data = await res.json();
    const bindingsData = bindingsRes ? await bindingsRes.json().catch(() => null) : null;
    bindingByPatient = new Map((bindingsData && bindingsData.success && Array.isArray(bindingsData.bindings) ? bindingsData.bindings : [])
      .map(b => [b.patient_id, b]));

    if (data.success) {
      cachedPatients = data.patients || [];
      updateCensusCounts();
      filterPatientTable(true);
    } else {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state" style="color:var(--danger);">The patients could not be loaded: ${escapeHtml(data.error || 'server error')}</td></tr>`;
    }
  } catch (err) {
    console.error('Failed to load patients directory:', err);
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state" style="color:var(--danger);">The server does not answer. Check that it is running, then reload the page.</td></tr>`;
  }
}

/**
 * Updates census count badges.
 */
function updateCensusCounts() {
  const admittedBadge = document.getElementById('patient-count-badge');
  const dischargedBadge = document.getElementById('discharged-count-badge');

  const admittedCount = cachedPatients.filter(p => p.status === 'ADMITTED').length;
  const dischargedCount = cachedPatients.filter(p => p.status === 'DISCHARGED').length;

  if (admittedBadge) admittedBadge.innerText = String(admittedCount);
  if (dischargedBadge) dischargedBadge.innerText = String(dischargedCount);
}

/**
 * Renders the patient records table with separated Age and Sex columns and clickable rows.
 */
function renderPatientsTable(patients) {
  const tbody = document.getElementById('patients-table-body');
  if (!tbody) return;

  const pagerEl = document.getElementById('patients-pager');
  if (!patients || patients.length === 0) {
    const searching = (document.getElementById('patient-search-input')?.value || '').trim() !== '';
    const emptyHtml = searching
      ? '<strong>No patient matches the search.</strong>Check the spelling, or search by ID, IC, ward or bed.'
      : currentPatientFilter === 'DISCHARGED'
        ? '<strong>No discharged patients.</strong>'
        : '<strong>No patients admitted.</strong>Press "＋ Admit patient" to add the first one.';
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${emptyHtml}</td></tr>`;
    if (pagerEl) window.ShiroUI.renderPager(pagerEl, { total: 0, page: 1, noun: 'patients' });
    return;
  }

  const pageData = window.ShiroUI.paginate(patients, currentPatientPage);
  currentPatientPage = pageData.page;
  if (pagerEl) {
    window.ShiroUI.renderPager(pagerEl, {
      total: pageData.total, page: pageData.page, noun: 'patients',
      onPage: (n) => { currentPatientPage = n; renderPatientsTable(patients); }
    });
  }

  tbody.innerHTML = pageData.items.map(p => {
    // Photo or initials fallback
    const initials = p.full_name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    const photoImg = p.photo_url 
      ? `<img src="${escapeHtml(p.photo_url)}" alt="${escapeHtml(p.full_name)}"${imgFallbackAttrs(initials)}>`
      : escapeHtml(initials);

    // Bed and Ward info
    const bedInfo = p.status === 'ADMITTED' && p.assigned_bed_id
      ? `<span class="badge badge-info">${escapeHtml(p.assigned_ward_id)} · ${escapeHtml(p.bed_code || p.assigned_bed_id)}</span>`
      : `<span class="badge badge-neutral">No bed</span>`;

    // Status pill
    const statusBadge = p.status === 'ADMITTED'
      ? `<span class="badge badge-live">● Admitted</span>`
      : `<span class="badge badge-neutral">● Discharged</span>`;

    // The wristband: worn now, or a button to give one (admitted patients only)
    const worn = bindingByPatient.get(p.patient_id);
    const wristbandCell = worn
      ? `<span class="badge badge-info">${escapeHtml(worn.device_id)}</span> <span class="status-word" style="color: var(--text-muted);">${escapeHtml(worn.device_status === 'ONLINE' || worn.device_status === 'CHARGING' ? '● ON' : '○ OFF')}</span>`
      : p.status === 'ADMITTED'
        ? `<button class="btn btn-outline btn-sm"${actionAttrs('openGiveWristband', [p.patient_id, p.full_name], { stop: true })}>＋ Give wristband</button>`
        : '<span style="color: var(--text-muted);">–</span>';
    // The one obvious next step: a bed for an admitted patient without one; a discharged
    // patient who comes back is admitted again with a bed (same record, a new stay)
    const secondaryActionBtn = p.status === 'ADMITTED' && !p.assigned_bed_id
      ? `<button class="btn btn-primary btn-sm"${actionAttrs('openAssignBedModal', [p.patient_id], { stop: true })} style="margin-right: 4px;">Give bed</button>`
      : p.status === 'DISCHARGED'
        ? `<button class="btn btn-outline btn-sm"${actionAttrs('openAssignBedModal', [p.patient_id], { stop: true })} style="margin-right: 4px;" title="The patient is back: choose a bed, the stay starts now">↩ Admit again</button>`
        : '';

    const genderLabel = p.gender === 'FEMALE' ? 'Female' : p.gender === 'MALE' ? 'Male' : 'Other';

    return `
      <tr class="table-row-clickable"${actionAttrs('viewPatientProfileReadOnly', [p.patient_id])} title="Open the profile of ${escapeHtml(p.full_name)}">
        <td>
          <div class="patient-cell">
            <div class="patient-thumb" title="${escapeHtml(p.full_name)}">
              ${photoImg}
            </div>
            <div>
              <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(p.full_name)}</div>
              <div class="mono" style="font-size: 12px; color: var(--text-muted); font-weight: 600;">${escapeHtml(p.patient_id)}</div>
            </div>
          </div>
        </td>
        <td>${escapeHtml(p.age !== null ? p.age + ' years' : '–')}</td>
        <td>${genderLabel}</td>
        <td>${bedInfo}</td>
        <td>${wristbandCell}</td>
        <td style="color: var(--text-secondary);">${escapeHtml(p.admission_date || '–')}</td>
        <td>${statusBadge}</td>
        <td style="text-align: right; white-space: nowrap;">
          <button class="btn btn-outline btn-sm"${actionAttrs('openPatientVitalsHistoryModal', [p.patient_id, p.full_name], { stop: true })} title="Heart rate and SpO2 over time" style="margin-right: 4px;">📈 Vitals</button>
          <button class="btn btn-outline btn-sm"${actionAttrs('openIncidentHistoryModal', [p.patient_id, p.full_name], { stop: true })} title="Falls, critical vitals and door alerts of this patient" style="margin-right: 4px;">🚨 Incidents</button>
          ${secondaryActionBtn}
          <button class="btn btn-outline btn-sm" data-row-menu="1"${actionAttrs('openPatientRowMenu', [p.patient_id], { stop: true, element: true })} title="Edit, bed, wristband, discharge, delete" aria-haspopup="true">⋯</button>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Filter table by status (ALL, ADMITTED, DISCHARGED).
 */
function setPatientFilter(filter, btn) {
  currentPatientFilter = filter;
  currentPatientPage = 1;
  document.querySelectorAll('#patient-filter-pills .filter-pill').forEach(b => b.classList.toggle('active', b.getAttribute('data-filter') === filter));
  if (btn) btn.classList.add('active');
  filterPatientTable(true);
}

/**
 * Real-time search filter across patient name, ID, NRIC, bed, or ward.
 */
function filterPatientTable(keepPage = false) {
  const input = document.getElementById('patient-search-input');
  const q = input ? input.value.trim().toLowerCase() : '';
  if (keepPage !== true) currentPatientPage = 1;

  const byStatus = currentPatientFilter === 'ALL'
    ? cachedPatients
    : cachedPatients.filter(p => p.status === currentPatientFilter);

  if (!q) {
    renderPatientsTable(byStatus);
    return;
  }

  const filtered = byStatus.filter(p => {
    return (
      p.full_name.toLowerCase().includes(q) ||
      p.patient_id.toLowerCase().includes(q) ||
      p.nric_passport.toLowerCase().includes(q) ||
      (p.assigned_ward_id && p.assigned_ward_id.toLowerCase().includes(q)) ||
      (p.assigned_bed_id && p.assigned_bed_id.toLowerCase().includes(q)) ||
      (p.bed_code && p.bed_code.toLowerCase().includes(q))
    );
  });

  renderPatientsTable(filtered);
}

/**
 * Comprehensive client-side form validation before registration.
 */
function validateAdmissionForm() {
  let isValid = true;
  let firstInvalidEl = null;

  const markInvalid = (el, msg) => {
    setValidationError(el, msg);
    isValid = false;
    if (!firstInvalidEl) firstInvalidEl = el;
  };

  // 1. Legal Name
  const nameEl = document.getElementById('adm-name');
  const nameVal = nameEl ? nameEl.value.trim() : '';
  if (!nameVal || !/^[a-zA-Z\s.'\-@/]{2,}$/.test(nameVal)) {
    markInvalid(nameEl, 'Please enter a valid legal full name (at least 2 alphabetic characters).');
  } else {
    clearValidation(nameEl);
  }

  // 2. Date of Birth
  const dobEl = document.getElementById('adm-dob');
  const dobVal = dobEl ? dobEl.value : '';
  const today = new Date().toISOString().split('T')[0];

  if (!dobVal) {
    markInvalid(dobEl, 'Date of birth is required.');
  } else if (dobVal > today) {
    markInvalid(dobEl, 'Date of birth cannot be in the future.');
  } else if (new Date(dobVal).getFullYear() < 1900) {
    markInvalid(dobEl, 'Date of birth year must be 1900 or later.');
  } else {
    clearValidation(dobEl);
  }

  // 3. NRIC / Passport
  const nricEl = document.getElementById('adm-nric');
  const nricVal = nricEl ? nricEl.value.trim() : '';
  const cleanNric = nricVal.replace(/[-\s]/g, '').toUpperCase();

  if (!nricVal) {
    markInvalid(nricEl, 'National ID / NRIC or Passport number is required.');
  } else {
    const isPureDigits = /^\d+$/.test(cleanNric);
    if (isPureDigits) {
      if (cleanNric.length !== 12) {
        markInvalid(nricEl, `Malaysian NRIC must be exactly 12 digits (currently ${cleanNric.length} digits).`);
      } else if (dobVal) {
        // Validate IC prefix against DOB
        const dobParts = dobVal.split('-');
        const expectedPrefix = `${dobParts[0].substring(2)}${dobParts[1]}${dobParts[2]}`;
        const actualPrefix = cleanNric.substring(0, 6);
        if (actualPrefix !== expectedPrefix) {
          markInvalid(dobEl, `Date of Birth (${dobParts[0]}-${dobParts[1]}-${dobParts[2]}) does not match NRIC birthdate prefix (${actualPrefix}).`);
          clearValidation(nricEl);
        } else {
          clearValidation(nricEl);
        }
      } else {
        clearValidation(nricEl);
      }
    } else {
      // Foreign Passport (must have 6 to 12 alphanumeric characters)
      const isPassport = /^[A-Za-z0-9]{6,12}$/.test(cleanNric);
      if (!isPassport) {
        markInvalid(nricEl, 'Foreign passport must be 6 to 12 alphanumeric characters.');
      } else {
        clearValidation(nricEl);
      }
    }
  }

  // 4. Biological Sex (Must be selected)
  const sexEl = document.getElementById('adm-sex');
  const sexVal = sexEl ? sexEl.value : '';
  if (!sexVal) {
    markInvalid(sexEl, 'Please select biological sex.');
  } else {
    clearValidation(sexEl);
  }

  // 5. Duplicate Check in Client Cache
  if (cleanNric && cachedPatients.length > 0) {
    const duplicate = cachedPatients.find(p => p.nric_passport.replace(/[-\s]/g, '').toUpperCase() === cleanNric);
    if (duplicate) {
      markInvalid(nricEl, `Patient already registered (${duplicate.full_name}, ${duplicate.patient_id}).`);
      if (window.showModal) {
        window.showModal({
          title: '⚠️ Patient Already Registered',
          message: `A patient with IC/Passport "${nricVal}" is already registered in the system:\n\n• Legal Name: ${duplicate.full_name}\n• Patient ID: ${duplicate.patient_id}\n• Status: ${duplicate.status}\n• Location: ${duplicate.assigned_ward_id ? duplicate.assigned_ward_id + ' · ' + (duplicate.bed_code || duplicate.assigned_bed_id) : 'Unassigned'}\n\nPlease check the existing record in the census directory or use a different identification number.`,
          type: 'warning',
          confirmText: 'OK',
          cancelText: null
        });
      }
    }
  }

  // 6. Emergency Phone
  const phoneEl = document.getElementById('adm-phone');
  const phoneVal = phoneEl ? phoneEl.value.trim() : '';
  const cleanPhone = phoneVal.replace(/[-\s()+]/g, '');
  if (!cleanPhone || cleanPhone.length < 8 || cleanPhone.length > 15 || !/^\d+$/.test(cleanPhone)) {
    markInvalid(phoneEl, 'Please enter a valid phone number (at least 8 digits, e.g. +6012-3456789 or 012-3456789).');
  } else {
    clearValidation(phoneEl);
  }

  if (!isValid && firstInvalidEl) {
    firstInvalidEl.focus();
    if (window.showToast) window.showToast('Please fix the highlighted invalid fields before registering.', 'warning');
  }

  return isValid;
}

/**
 * Handles patient admission submission with confirmation prompt and photo upload.
 */
async function handlePatientAdmission(event) {
  if (event) event.preventDefault();

  // Run comprehensive validation
  if (!validateAdmissionForm()) {
    return;
  }

  const id = document.getElementById('adm-id').value.trim();
  const name = document.getElementById('adm-name').value.trim();
  const nric = document.getElementById('adm-nric').value.trim();
  const dob = document.getElementById('adm-dob').value;
  const sex = document.getElementById('adm-sex').value;
  const phone = document.getElementById('adm-phone').value.trim();
  const wardId = document.getElementById('adm-ward').value;
  const bedId = document.getElementById('adm-bed').value;
  const history = document.getElementById('adm-history').value.trim();
  let photoUrl = document.getElementById('adm-photo-url').value;
  const body = readBodyMeasurements('adm-height', 'adm-weight');
  if (body.error) {
    if (window.showToast) window.showToast(body.error, 'warning');
    return;
  }

  const hasBedAssignment = wardId && bedId;
  let confirmTitle = '';
  let confirmMessage = '';
  let confirmButtonText = '';

  if (hasBedAssignment) {
    const wardOption = document.querySelector(`#adm-ward option[value="${wardId}"]`);
    const bedOption = document.querySelector(`#adm-bed option[value="${bedId}"]`);
    const wardTitle = wardOption ? wardOption.innerText : wardId;
    const bedTitle = bedOption ? bedOption.innerText : bedId;

    confirmTitle = 'Admit this patient?';
    confirmMessage = `${name} (${id})\n\n• Ward: ${wardTitle}\n• Bed: ${bedTitle}\n\nThe bed will show as occupied.`;
    confirmButtonText = 'Admit';
  } else {
    confirmTitle = 'Admit without a bed?';
    confirmMessage = `${name} (${id}) will be admitted without a ward and bed.\n\nYou can give a bed later with "Assign bed" in the list.`;
    confirmButtonText = 'Admit without a bed';
  }

  // Show Confirmation Modal
  if (window.showModal) {
    window.showModal({
      title: confirmTitle,
      message: confirmMessage,
      type: 'info',
      confirmText: confirmButtonText,
      cancelText: 'Cancel',
      onConfirm: async () => {
        try {
          // If custom base64 image, upload it first
          if (photoUrl.startsWith('data:image/')) {
            const uploadRes = await fetch('/api/patients/upload-photo', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ patient_id: id, image_data: photoUrl })
            });
            const uploadData = await uploadRes.json();
            if (!uploadData.success || !uploadData.photo_url) {
              // Without a stored photo the admission is not sent: the patient is not admitted with a broken picture
              if (window.showToast) window.showToast(`Photo upload failed: ${uploadData.error || 'unknown error'}`, 'danger');
              return;
            }
            photoUrl = uploadData.photo_url;
          }

          // Submit admission to API
          const payload = {
            patient_id: id,
            full_name: name,
            nric_passport: nric,
            dob: dob,
            gender: sex,
            phone_number: phone,
            assigned_ward_id: wardId || null,
            assigned_bed_id: bedId || null,
            height_cm: body.height_cm,
            weight_kg: body.weight_kg,
            medical_history: history,
            photo_url: photoUrl
          };

          const res = await fetch('/api/patients/admit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const result = await res.json();
          if (result.success) {
            if (window.showToast) {
              window.showToast(`${name} (${result.patient_id}) admitted.`, 'success');
            }
            resetAdmissionForm();
            toggleAdmissionForm(false);
            setPatientFilter('ADMITTED');
            // Refresh data
            await Promise.all([
              fetchNextPatientId(),
              fetchAvailableBedsAndWards(),
              loadPatientsDirectory()
            ]);
          } else {
            if (window.showModal) {
              window.showModal({
                title: 'The patient was not admitted',
                message: result.error || 'The server could not save the patient. Try again.',
                type: 'danger',
                confirmText: 'OK',
                cancelText: null
              });
            }
          }
        } catch (err) {
          console.error('Admission error:', err);
          if (window.showToast) window.showToast('The server does not answer. The patient was not admitted; try again.', 'danger');
        }
      }
    });
  }
}

/**
 * Prompts danger confirmation modal before discharging a patient.
 */
function confirmDischargePatient(patientId, patientName, bedInfo) {
  if (window.showModal) {
    const worn = bindingByPatient.get(patientId);
    window.showModal({
      title: `Discharge ${patientName}?`,
      message: `${patientName} (${patientId}) leaves the ward. The record and its history stay; "Admit again" brings them back.`,
      impact: {
        level: 'warning',
        title: 'Discharging will:',
        points: [
          `Free their bed (${bedInfo}) for another patient.`,
          worn ? `Take off their wristband ${worn.device_id}: heart rate, fall alarms, door alerts and position stop.` : 'They wear no wristband: nothing else stops.',
          'Remove them from the ward map and the patient list (they stay under Discharged).'
        ]
      },
      type: 'warning',
      confirmText: 'Discharge',
      cancelText: 'Cancel',
      onConfirm: async () => {
        try {
          const res = await fetch('/api/patients/discharge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patient_id: patientId })
          });
          const result = await res.json();
          if (result.success) {
            if (window.showToast) {
              window.showToast(`Patient ${patientName} has been discharged and bed released.`, 'info');
            }
            await Promise.all([
              fetchAvailableBedsAndWards(),
              loadPatientsDirectory()
            ]);
          } else {
            if (window.showToast) window.showToast(`Discharge failed: ${result.error}`, 'danger');
          }
        } catch (err) {
          console.error('Discharge error:', err);
          if (window.showToast) window.showToast('Network error during patient discharge.', 'danger');
        }
      }
    });
  }
}

/**
 * Prompts danger confirmation modal before deleting a patient record.
 */
function confirmDeletePatient(patientId, patientName) {
  if (window.showModal) {
    window.showModal({
      title: `Delete the record of ${patientName}?`,
      message: `To end a stay normally, use "Discharge" instead: it keeps the record.`,
      impact: {
        level: 'danger',
        title: 'Deleting the record will:',
        points: [
          `Delete ${patientName} (${patientId}) and their wristband history for good.`,
          'Free their bed and their wristband; heart rate, fall alarms and position stop.',
          'This cannot be undone.'
        ]
      },
      type: 'danger',
      confirmText: 'Delete for good',
      cancelText: 'Cancel',
      onConfirm: async () => {
        try {
          const res = await fetch('/api/patients/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patient_id: patientId })
          });
          const result = await res.json();
          if (result.success) {
            if (window.showToast) {
              window.showToast(`Patient ${patientName} (${patientId}) permanently deleted.`, 'success');
            }
            await Promise.all([
              fetchNextPatientId(),
              fetchAvailableBedsAndWards(),
              loadPatientsDirectory()
            ]);
          } else {
            if (window.showToast) window.showToast(`Deletion failed: ${result.error}`, 'danger');
          }
        } catch (err) {
          console.error('Delete error:', err);
          if (window.showToast) window.showToast('Network error deleting patient.', 'danger');
        }
      }
    });
  }
}

/**
 * Opens a modal to assign a bed to a discharged or unassigned patient.
 */
/**
 * The ward seen from above in the "give a bed" dialog: free beds green and
 * clickable, taken or unavailable beds grey. Same layout as the ward editor
 * (x east, y north, from the south-west corner).
 */
async function drawBedPickerMap(wardId, freeBedIds) {
  const box = document.getElementById('modal-bed-map');
  if (!box) return;
  box.innerHTML = '<div class="empty-state">Loading the ward…</div>';
  let ward;
  try {
    const res = await fetch(`/api/ward/config?ward_id=${encodeURIComponent(wardId)}`);
    const data = await res.json();
    ward = data.success ? data.ward : null;
  } catch (err) {
    ward = null;
  }
  if (!ward || !(Number(ward.length_x) > 0) || !(Number(ward.width_y) > 0)) {
    box.innerHTML = '<div class="empty-state">The layout of this ward is not drawn yet. Choose the bed in the list.</div>';
    return;
  }
  const L = Number(ward.length_x);
  const W = Number(ward.width_y);
  const scale = Math.min(460 / L, 240 / W);
  const pad = 10;
  const sw = L * scale + pad * 2;
  const sh = W * scale + pad * 2;
  const bedShapes = (ward.beds || []).map(bed => {
    const rot = ((parseInt(bed.rotation_deg, 10) || 0) % 360 + 360) % 360;
    const along = rot === 90 || rot === 270;
    const bw = (along ? Number(bed.length) || 2 : Number(bed.width) || 0.9) * scale;
    const bl = (along ? Number(bed.width) || 0.9 : Number(bed.length) || 2) * scale;
    const x = pad + (Number(bed.x) || 0) * scale;
    const y = pad + (W - (Number(bed.y) || 0)) * scale - bl;
    const free = freeBedIds.has(bed.bed_id);
    return `<g class="bed-pick ${free ? 'free' : 'taken'}" data-bed="${escapeHtml(bed.bed_id)}">
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bl.toFixed(1)}" rx="4"></rect>
        <text x="${(x + bw / 2).toFixed(1)}" y="${(y + bl / 2 + 4).toFixed(1)}" text-anchor="middle">${escapeHtml(bed.bed_code || bed.bed_id)}</text>
        <title>${escapeHtml(free ? 'Free: click to choose' : 'Taken or out of use')}</title>
      </g>`;
  }).join('');
  box.innerHTML = `<svg viewBox="0 0 ${sw.toFixed(1)} ${sh.toFixed(1)}" role="img" aria-label="Beds of the ward">
      <rect class="room" x="${pad.toFixed(1)}" y="${pad.toFixed(1)}" width="${(L * scale).toFixed(1)}" height="${(W * scale).toFixed(1)}"></rect>
      ${bedShapes}
    </svg>`;
  box.querySelectorAll('.bed-pick.free').forEach(g => {
    g.addEventListener('click', () => {
      const sel = document.getElementById('modal-assign-bed');
      if (sel) sel.value = g.getAttribute('data-bed');
      highlightChosenBed();
    });
  });
}

/** Marks the bed chosen in the list on the map. */
function highlightChosenBed() {
  const sel = document.getElementById('modal-assign-bed');
  const chosen = sel ? sel.value : '';
  document.querySelectorAll('#modal-bed-map .bed-pick').forEach(g => g.classList.toggle('chosen', g.getAttribute('data-bed') === chosen));
}
window.highlightChosenBed = highlightChosenBed;

/**
 * The bed dialog. leavingWardId: the patient moves out of that ward (it is being
 * deleted): its beds are not offered, and the ward's delete dialog opens again
 * after the move.
 */
async function openAssignBedModal(patientId, leavingWardId = null) {
  try {
    const res = await fetch(`/api/patients/get?id=${encodeURIComponent(patientId)}`);
    const data = await res.json();
    if (!data.success || !data.patient) {
      if (window.showToast) window.showToast('Patient record not found.', 'warning');
      return;
    }
    const p = data.patient;

    // Refresh available beds list
    const bedsRes = await fetch('/api/patients/available-beds');
    const bedsData = await bedsRes.json();
    const wards = (bedsData.wards || []).filter(w => w.ward_id !== leavingWardId);
    const availableBeds = (bedsData.availableBeds || []).filter(b => b.ward_id !== leavingWardId);

    if (availableBeds.length === 0) {
      if (window.showModal) {
        window.showModal({
          title: 'No free bed',
          message: leavingWardId
            ? `No other ward has a free bed for ${p.full_name}.\n\nDischarge the patient (Patients page), or add beds to another ward under Setup → Wards & layout.`
            : 'Every bed in every ward is taken or out of use.\n\nDischarge a patient, or add beds under Setup → Wards & layout.',
          type: 'warning',
          confirmText: 'OK',
          cancelText: null
        });
      }
      return;
    }

    // Open on the first ward that has a free bed
    const firstFree = (wards.find(w => availableBeds.some(b => b.ward_id === w.ward_id)) || {}).ward_id;
    const wardOptions = wards.map(w => `<option value="${escapeHtml(w.ward_id)}"${w.ward_id === firstFree ? ' selected' : ''}>${escapeHtml(w.ward_id)} - ${escapeHtml(w.room_title)}${escapeHtml(availableBeds.some(b => b.ward_id === w.ward_id) ? '' : ' (no free bed)')}</option>`).join('');

    const readmit = p.status === 'DISCHARGED';
    const moving = Boolean(leavingWardId);
    const modalContent = `
      <div style="font-size:14px; color:var(--text-secondary); margin-bottom:12px;">
        ${readmit ? 'Admit' : moving ? 'Move' : 'A bed for'} <strong>${escapeHtml(p.full_name)}</strong> (${escapeHtml(p.patient_id)})${readmit ? ' again: a new stay starts now, with the same record and history' : ''}${escapeHtml(moving ? ` out of ${leavingWardId}, to a bed in another ward` : '')}. Click a green bed on the map, or choose it in the list.
      </div>
      <div class="form-group">
        <label class="form-label">Ward</label>
        <select class="form-control" id="modal-assign-ward" onchange="updateAssignBedModalBeds()">
          ${wardOptions}
        </select>
      </div>
      <div id="modal-bed-map" class="bed-map"></div>
      <div class="bed-map-legend"><span><i class="free"></i> Free</span><span><i class="taken"></i> Taken or out of use</span><span><i class="chosen"></i> Chosen</span></div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">Bed</label>
        <select class="form-control" id="modal-assign-bed" onchange="highlightChosenBed()">
        </select>
      </div>
    `;

    window._modalAvailableBeds = availableBeds;
    window.updateAssignBedModalBeds = async function() {
      const wardEl = document.getElementById('modal-assign-ward');
      const bedEl = document.getElementById('modal-assign-bed');
      if (!wardEl || !bedEl) return;
      const filtered = window._modalAvailableBeds.filter(b => b.ward_id === wardEl.value);
      if (filtered.length === 0) {
        bedEl.innerHTML = `<option value="" disabled selected>No free bed in this ward</option>`;
      } else {
        bedEl.innerHTML = filtered.map(b => `<option value="${escapeHtml(b.bed_id)}">${escapeHtml(b.bed_code)}</option>`).join('');
      }
      await drawBedPickerMap(wardEl.value, new Set(filtered.map(b => b.bed_id)));
      highlightChosenBed();
    };

    if (window.showModal) {
      window.showModal({
        title: readmit ? `Admit ${p.full_name} again` : moving ? `Move ${p.full_name} out of ${leavingWardId}` : `Give ${p.full_name} a bed`,
        customHtml: modalContent,
        isWide: true,
        type: 'info',
        confirmText: readmit ? 'Admit with this bed' : moving ? 'Move to this bed' : 'Give this bed',
        cancelText: 'Cancel',
        onConfirm: async () => {
          const wardId = document.getElementById('modal-assign-ward')?.value;
          const bedId = document.getElementById('modal-assign-bed')?.value;

          if (!wardId || !bedId) {
            if (window.showToast) window.showToast('Choose a free bed first.', 'warning');
            return;
          }

          try {
            const assignRes = await fetch('/api/patients/assign-bed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                patient_id: p.patient_id,
                ward_id: wardId,
                bed_id: bedId
              })
            });
            const assignResult = await assignRes.json();
            if (assignResult.success) {
              if (window.showToast) window.showToast(readmit ? `${p.full_name} is admitted again.` : `${p.full_name} now has a bed.`, 'success');
              // Back on the Admitted list, where they are now
              if (readmit && typeof window.setPatientFilter === 'function') window.setPatientFilter('ADMITTED');
              // Moved out of a ward being deleted: back to its delete dialog (the next patient, or the delete)
              if (moving && typeof window.deleteWardRecord === 'function') setTimeout(() => window.deleteWardRecord(leavingWardId), 400);
              await Promise.all([
                fetchAvailableBedsAndWards(),
                loadPatientsDirectory()
              ]);
            } else {
              if (window.showToast) window.showToast(`Not given: ${assignResult.error}`, 'danger');
            }
          } catch (err) {
            console.error('Assign bed error:', err);
            if (window.showToast) window.showToast('The server does not answer. The bed was not given.', 'danger');
          }
        }
      });
      // Trigger initial bed list update
      setTimeout(window.updateAssignBedModalBeds, 50);
    }
  } catch (err) {
    console.error('Open assign bed modal error:', err);
  }
}

/**
 * Opens read-only modal when clicking a row in the census table.
 */
async function viewPatientProfileReadOnly(patientId) {
  try {
    const res = await fetch(`/api/patients/get?id=${encodeURIComponent(patientId)}`);
    const data = await res.json();
    if (!data.success || !data.patient) {
      if (window.showToast) window.showToast('Patient record not found.', 'warning');
      return;
    }

    const p = data.patient;
    const photoSrc = p.photo_url || '/uploads/patients/preset_elderly_male.svg';
    const bedDesc = p.status === 'ADMITTED' && p.assigned_bed_id
      ? `${p.assigned_ward_id} - ${p.ward_title || ''} (Cubicle: ${p.bed_code || p.assigned_bed_id})`
      : 'No active bed (Discharged / Observation)';

    const genderLabel = p.gender === 'FEMALE' ? 'Female' : p.gender === 'MALE' ? 'Male' : 'Other';

    const modalContent = `
      <div style="display:flex; gap:16px; align-items:center; margin-bottom:16px;">
        <img src="${escapeHtml(photoSrc)}" alt="${escapeHtml(p.full_name)}" style="width:76px; height:76px; border-radius:50%; object-fit:cover; border:3px solid var(--primary); box-shadow:0 3px 10px rgba(0,0,0,0.1);">
        <div>
          <div style="font-size:18px; font-weight:700; color:var(--text-primary);">${escapeHtml(p.full_name)}</div>
          <div style="font-size:12px; color:var(--primary); font-weight:600;" class="mono">${escapeHtml(p.patient_id)} · NRIC: ${escapeHtml(p.nric_passport)}</div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:3px;">
            ${escapeHtml(p.age)} yrs · ${genderLabel} · DOB: ${escapeHtml(p.dob)} · 📞 ${escapeHtml(p.phone_number)}
          </div>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; background:#F8FAFC; border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:14px; font-size:12px;">
        <div>
          <span style="color:var(--text-muted);">Assigned Location:</span><br>
          <strong style="color:var(--text-primary);">${escapeHtml(bedDesc)}</strong>
        </div>
        <div>
          <span style="color:var(--text-muted);">Height / Weight:</span><br>
          <strong style="color:var(--text-primary);">${escapeHtml(bodySummary(p))}</strong>
        </div>
        <div>
          <span style="color:var(--text-muted);">Admission Timestamp:</span><br>
          <span style="color:var(--text-secondary);">${escapeHtml(p.admission_date || '-')}</span>
        </div>
        <div>
          <span style="color:var(--text-muted);">Status:</span><br>
          <strong style="color:${p.status === 'ADMITTED' ? 'var(--success)' : 'var(--text-muted)'};">${escapeHtml(p.status)}</strong>
        </div>
      </div>

      <div style="font-size:12px; background:#FFFFFF; border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:12px;">
        <div style="font-weight:600; color:var(--text-primary); margin-bottom:6px;">Medical history and allergies</div>
        <div style="color:var(--text-secondary); line-height:1.5; white-space:pre-wrap;">${escapeHtml(p.medical_history || 'Nothing recorded.')}</div>
      </div>

      <button type="button" class="btn btn-outline btn-sm"${actionAttrs('openPatientVitalsHistoryModal', [p.patient_id, p.full_name])} style="width:100%; display:flex; align-items:center; justify-content:center; gap:8px; font-weight:600; padding:8px 12px; color:var(--primary); border-color:var(--primary);">
        📈 <span>Vitals history (heart rate, SpO2)</span>
      </button>
      <button type="button" class="btn btn-outline btn-sm"${actionAttrs('openIncidentHistoryModal', [p.patient_id, p.full_name])} style="width:100%; display:flex; align-items:center; justify-content:center; gap:8px; font-weight:600; padding:8px 12px; margin-top:8px; color:var(--danger); border-color:var(--danger);">
        🚨 <span>Incidents (falls, critical vitals, door alerts)</span>
      </button>

      <!-- Wristband history: closed until clicked, 8 a page (Phase 11 review) -->
      <details class="profile-history">
        <summary>⌚ Wristband history <span class="badge badge-neutral" id="profile-binding-count">…</span></summary>
        <div id="profile-binding-history" style="color:var(--text-muted); margin-top:8px;">Loading…</div>
        <div id="profile-binding-pager"></div>
      </details>
    `;

    if (window.showModal) {
      window.showModal({
        title: `Patient Clinical Profile (Read-Only)`,
        customHtml: modalContent,
        type: 'info',
        confirmText: 'Close',
        cancelText: null
      });
      loadProfileBindingHistory(p.patient_id);
    }
  } catch (err) {
    console.error('View read-only profile error:', err);
  }
}

/**
 * Fills the profile's wristband history: every wristband this patient wore,
 * newest first, as a table of 8 a page (the same pager as the other tables).
 */
let profileHistory = [];

function renderProfileBindingHistory(page = 1) {
  const box = document.getElementById('profile-binding-history');
  const pagerEl = document.getElementById('profile-binding-pager');
  if (!box) return;
  const pageData = window.ShiroUI.paginate(profileHistory, page);
  const duration = window.formatBindingDuration || ((m) => `${m} min`);
  const historyItems = pageData.items.map(b => `<tr>
      <td><span class="mono" style="font-weight:600; color:var(--text-primary);">${escapeHtml(b.device_id || 'deleted wristband')}</span></td>
      <td>${escapeHtml(b.bound_at || 'not recorded')}<div class="profile-history-who">${escapeHtml(b.bound_by || '')}</div></td>
      <td>${escapeHtml(b.status === 'ACTIVE' ? 'now' : (b.unbound_at || 'not recorded'))}<div class="profile-history-who">${escapeHtml(b.status === 'ACTIVE' ? '' : (b.unbound_by || ''))}</div></td>
      <td><span class="badge ${b.status === 'ACTIVE' ? 'badge-live' : 'badge-neutral'}">${escapeHtml(b.status === 'ACTIVE' ? 'Worn now' : b.status === 'DISCHARGED' ? 'Discharged' : 'Taken off')}</span></td>
      <td>${escapeHtml(duration(b.duration_minutes))}${escapeHtml(b.status === 'ACTIVE' ? ' so far' : '')}</td>
    </tr>`).join('');
  box.innerHTML = `<table class="data-table profile-history-table">
      <thead><tr><th>Wristband</th><th>From</th><th>Until</th><th>Ended</th><th>For</th></tr></thead>
      <tbody>${historyItems}</tbody>
    </table>`;
  if (pagerEl) {
    window.ShiroUI.renderPager(pagerEl, {
      total: pageData.total, page: pageData.page, noun: 'wristbands',
      onPage: (n) => renderProfileBindingHistory(n)
    });
  }
}

async function loadProfileBindingHistory(patientId) {
  const box = document.getElementById('profile-binding-history');
  const countEl = document.getElementById('profile-binding-count');
  profileHistory = [];
  let text = null;
  try {
    const res = await fetch(`/api/bindings/history?patient_id=${encodeURIComponent(patientId)}&limit=500`);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.history)) {
      text = 'Wristband history could not be loaded.';
    } else if (data.history.length === 0) {
      text = 'No wristband has been given to this patient yet.';
    } else {
      profileHistory = data.history;
    }
  } catch (err) {
    text = 'Wristband history could not be loaded.';
  }
  if (countEl) countEl.innerText = text === null ? String(profileHistory.length) : '0';
  if (!box) return;
  if (text !== null) box.textContent = text;
  else renderProfileBindingHistory(1);
}

/**
 * Opens "Edit Infos" modal where ONLY Phone, Fall Risk, and Notes can be modified,
 * with confirmation prompt on saving changes.
 */
async function editPatientInfo(patientId) {
  try {
    const res = await fetch(`/api/patients/get?id=${encodeURIComponent(patientId)}`);
    const data = await res.json();
    if (!data.success || !data.patient) {
      if (window.showToast) window.showToast('Patient record not found.', 'warning');
      return;
    }

    const p = data.patient;
    const photoSrc = p.photo_url || '/uploads/patients/preset_elderly_male.svg';
    const bedDesc = p.status === 'ADMITTED' && p.assigned_bed_id
      ? `${p.assigned_ward_id} · ${p.bed_code || p.assigned_bed_id}`
      : 'No active bed (Discharged / Observation)';

    const genderLabel = p.gender === 'FEMALE' ? 'Female' : p.gender === 'MALE' ? 'Male' : 'Other';

    // Global helpers for editing patient photo inside modal
    window.handleEditPhotoFileUpload = function(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;

      // The server stores PNG, JPEG and WebP only
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        if (window.showToast) window.showToast('Please select a JPG, PNG or WebP image.', 'warning');
        return;
      }

      if (file.size > 3 * 1024 * 1024) {
        if (window.showToast) window.showToast('Image file too large. Maximum size is 3MB.', 'warning');
        return;
      }

      const reader = new FileReader();
      reader.onload = function(e) {
        const preview = document.getElementById('edit-patient-photo-preview');
        const input = document.getElementById('edit-patient-photo-url');
        if (preview) preview.src = e.target.result;
        if (input) input.value = e.target.result;
        document.querySelectorAll('.edit-avatar-btn').forEach(b => b.classList.remove('active'));
        if (window.showToast) window.showToast('New photo ready to be saved.', 'info');
      };
      reader.readAsDataURL(file);
    };

    window.selectEditAvatarPreset = function(url, btn) {
      const preview = document.getElementById('edit-patient-photo-preview');
      const input = document.getElementById('edit-patient-photo-url');
      if (preview) preview.src = url;
      if (input) input.value = url;
      document.querySelectorAll('.edit-avatar-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
    };

    const modalContent = `
      <div style="display:flex; gap:16px; align-items:center; margin-bottom:16px;">
        <div style="position:relative; width:68px; height:68px; flex-shrink:0;">
          <img id="edit-patient-photo-preview" src="${escapeHtml(photoSrc)}" alt="${escapeHtml(p.full_name)}" style="width:68px; height:68px; border-radius:50%; object-fit:cover; border:2.5px solid var(--primary); box-shadow:0 2px 8px rgba(0,0,0,0.12);">
        </div>
        <div style="flex:1;">
          <div style="font-size:16px; font-weight:700; color:var(--text-primary);">${escapeHtml(p.full_name)}</div>
          <div style="font-size:11px; color:var(--primary); font-weight:600;" class="mono">${escapeHtml(p.patient_id)} · NRIC: ${escapeHtml(p.nric_passport)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
            ${escapeHtml(p.age !== null ? p.age + ' yrs' : '-')} · ${genderLabel} · DOB: ${escapeHtml(p.dob)} · Location: ${escapeHtml(bedDesc)}
          </div>
          
          <!-- Photo Re-upload / Preset Select Bar -->
          <div style="margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <input type="file" id="edit-patient-photo-file" accept="image/png,image/jpeg,image/webp" style="display:none;" onchange="handleEditPhotoFileUpload(event)">
            <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('edit-patient-photo-file').click()" style="font-size:11px; padding:3px 9px;">
              📷 Re-upload Photo
            </button>
            <div style="display:inline-flex; gap:4px; align-items:center;">
              <span style="font-size:10px; color:var(--text-muted);">Presets:</span>
              <button type="button" class="edit-avatar-btn btn btn-outline btn-sm" title="Adult Male" onclick="selectEditAvatarPreset('/uploads/patients/preset_adult_male.svg', this)" style="padding:2px; width:26px; height:26px; border-radius:50%; border:1px solid var(--border);">
                <img src="/uploads/patients/preset_adult_male.svg" style="width:20px; height:20px; border-radius:50%;">
              </button>
              <button type="button" class="edit-avatar-btn btn btn-outline btn-sm" title="Adult Female" onclick="selectEditAvatarPreset('/uploads/patients/preset_adult_female.svg', this)" style="padding:2px; width:26px; height:26px; border-radius:50%; border:1px solid var(--border);">
                <img src="/uploads/patients/preset_adult_female.svg" style="width:20px; height:20px; border-radius:50%;">
              </button>
              <button type="button" class="edit-avatar-btn btn btn-outline btn-sm" title="Elderly Male" onclick="selectEditAvatarPreset('/uploads/patients/preset_elderly_male.svg', this)" style="padding:2px; width:26px; height:26px; border-radius:50%; border:1px solid var(--border);">
                <img src="/uploads/patients/preset_elderly_male.svg" style="width:20px; height:20px; border-radius:50%;">
              </button>
              <button type="button" class="edit-avatar-btn btn btn-outline btn-sm" title="Elderly Female" onclick="selectEditAvatarPreset('/uploads/patients/preset_elderly_female.svg', this)" style="padding:2px; width:26px; height:26px; border-radius:50%; border:1px solid var(--border);">
                <img src="/uploads/patients/preset_elderly_female.svg" style="width:20px; height:20px; border-radius:50%;">
              </button>
            </div>
          </div>
          <input type="hidden" id="edit-patient-photo-url" value="${escapeHtml(photoSrc)}">
        </div>
      </div>

      <div style="border-top:1px solid var(--border); padding-top:12px;">
        <div class="form-group">
          <label class="form-label" style="font-weight:600;">Emergency Contact Phone <span class="req" aria-hidden="true">*</span></label>
          <input type="text" class="form-control" id="edit-patient-phone" value="${escapeHtml(p.phone_number || '')}" placeholder="+6012-3456789">
        </div>


        <div class="form-row" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <div class="form-group">
            <label class="form-label">Height (cm)</label>
            <input type="number" class="form-control" id="edit-patient-height" min="40" max="230" step="1" placeholder="Optional" value="${escapeHtml(p.height_cm ?? '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Weight (kg)</label>
            <input type="number" class="form-control" id="edit-patient-weight" min="2" max="300" step="0.1" placeholder="Optional" value="${escapeHtml(p.weight_kg ?? '')}">
          </div>
        </div>

        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label" style="font-weight:600;">Medical History, Chronic Conditions &amp; Drug Allergies</label>
          <textarea id="edit-patient-history" class="form-control" rows="3" style="font-size:12px;">${escapeHtml(p.medical_history || '')}</textarea>
        </div>
      </div>
    `;

    if (window.showModal) {
      window.showModal({
        title: `Edit Clinical Information: ${p.full_name} (${p.patient_id})`,
        customHtml: modalContent,
        type: 'info',
        confirmText: 'Save Notes',
        cancelText: 'Cancel',
        onConfirm: () => {
          const updatedPhone = document.getElementById('edit-patient-phone')?.value.trim();
          const updatedHistory = document.getElementById('edit-patient-history')?.value.trim();
          let updatedPhoto = document.getElementById('edit-patient-photo-url')?.value || photoSrc;
          const updatedBody = readBodyMeasurements('edit-patient-height', 'edit-patient-weight');
          if (updatedBody.error) {
            if (window.showToast) window.showToast(updatedBody.error, 'warning');
            return;
          }

          // Validation
          if (!updatedPhone || !/^(\+?6?01[0-9]{1}-?[0-9]{7,8}|\+?[0-9\s-]{8,15})$/.test(updatedPhone)) {
            if (window.showToast) window.showToast('Please enter a valid phone number before saving.', 'warning');
            return;
          }

          // Confirmation prompt before saving notes / changes
          window.showModal({
            title: 'Save the changes?',
            message: `${p.full_name} (${p.patient_id})\n\n• Phone: ${updatedPhone}\n• Height / weight: ${bodySummary(updatedBody)}\n• Photo: ${updatedPhoto !== photoSrc ? 'new photo' : 'unchanged'}`,
            type: 'info',
            confirmText: 'Save',
            cancelText: 'Cancel',
            onConfirm: async () => {
              try {
                // If custom base64 image, upload it first
                if (updatedPhoto && updatedPhoto.startsWith('data:image/')) {
                  const uploadRes = await fetch('/api/patients/upload-photo', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ patient_id: p.patient_id, image_data: updatedPhoto })
                  });
                  const uploadData = await uploadRes.json();
                  if (!uploadData.success || !uploadData.photo_url) {
                    if (window.showToast) window.showToast(`Photo upload failed: ${uploadData.error || 'unknown error'}`, 'danger');
                    return;
                  }
                  updatedPhoto = uploadData.photo_url;
                }

                const updateRes = await fetch('/api/patients/update', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    patient_id: p.patient_id,
                    phone_number: updatedPhone,
                    height_cm: updatedBody.height_cm,
                    weight_kg: updatedBody.weight_kg,
                    medical_history: updatedHistory,
                    photo_url: updatedPhoto
                  })
                });
                const updateResult = await updateRes.json();
                if (updateResult.success) {
                  if (window.showToast) window.showToast('Clinical notes and profile updated successfully.', 'success');
                  loadPatientsDirectory();
                } else {
                  if (window.showToast) window.showToast(`Update failed: ${updateResult.error}`, 'danger');
                }
              } catch (err) {
                console.error('Update notes error:', err);
                if (window.showToast) window.showToast('Network error saving changes.', 'danger');
              }
            }
          });
        }
      });
    }
  } catch (err) {
    console.error('Edit patient info error:', err);
  }
}

/**
 * Resets the admission form back to defaults.
 */
function resetAdmissionForm() {
  const form = document.getElementById('form-patient-admission');
  if (form) form.reset();

  // Clear all invalid validation highlights
  document.querySelectorAll('#form-patient-admission .is-invalid').forEach(el => clearValidation(el));

  // Reset Photo to default elderly male
  const defaultPhoto = '/uploads/patients/preset_elderly_male.svg';
  const previewImg = document.getElementById('adm-photo-img');
  const photoUrlEl = document.getElementById('adm-photo-url');
  if (previewImg) previewImg.src = defaultPhoto;
  if (photoUrlEl) photoUrlEl.value = defaultPhoto;

  document.querySelectorAll('.preset-avatar-btn').forEach(b => b.classList.remove('active'));
  const firstBtn = document.querySelector('.preset-avatar-btn');
  if (firstBtn) firstBtn.classList.add('active');

  // Reset DOB, Age & Sex
  const dobEl = document.getElementById('adm-dob');
  if (dobEl) dobEl.value = '';
  const ageBadge = document.getElementById('adm-age-badge');
  if (ageBadge) ageBadge.innerText = '--';
  const sexEl = document.getElementById('adm-sex');
  if (sexEl) sexEl.value = '';

  for (const fieldId of ['adm-height', 'adm-weight']) {
    const el = document.getElementById(fieldId);
    if (el) el.value = '';
  }

  handleNameOrDobChange();

  // Restore next patient ID & Ward
  fetchNextPatientId();
  populateWardDropdown();
  handleWardSelectionChange();
}

// =============================================================================
// HISTORICAL TIME-SERIES VITALS VIEWER (INFLUXDB ENGINE - TABLE 4.10)
// Retention Policy: 30 Days (Downsampled after 7d)
// =============================================================================

/**
 * Opens InfluxDB Historical Vitals Modal with range filtering (-1h, -6h, -24h, -7d, -30d)
 */
async function openPatientVitalsHistoryModal(patientId, patientName, defaultRange = '-24h') {
  const safeName = patientName || patientId;
  const modalHtml = `
    <div style="margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
      <div>
        <div style="font-size: 16px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
          <span>📈 ${escapeHtml(safeName)}</span>
          <span class="mono" style="font-size: 12px; color: var(--primary); font-weight: 600;">(${escapeHtml(patientId)})</span>
        </div>
        <div style="font-size: 13px; color: var(--text-muted); margin-top: 2px;">
          Heart rate and SpO2 measured by the wristband. Kept for 30 days.
        </div>
      </div>
      
      <!-- Range Filter Buttons -->
      <div id="vitals-range-pills" style="display: flex; gap: 6px; background: #F1F5F9; padding: 4px; border-radius: 6px; border: 1px solid var(--border);">
        <button type="button" class="btn btn-outline btn-sm range-btn" data-range="-1h"${actionAttrs('switchVitalsHistoryRange', [patientId, safeName, '-1h'], { element: true })} style="padding: 4px 10px; font-size: 11px; font-weight: 600;">1h</button>
        <button type="button" class="btn btn-outline btn-sm range-btn" data-range="-6h"${actionAttrs('switchVitalsHistoryRange', [patientId, safeName, '-6h'], { element: true })} style="padding: 4px 10px; font-size: 11px; font-weight: 600;">6h</button>
        <button type="button" class="btn btn-primary btn-sm range-btn" data-range="-24h"${actionAttrs('switchVitalsHistoryRange', [patientId, safeName, '-24h'], { element: true })} style="padding: 4px 10px; font-size: 11px; font-weight: 600;">24h</button>
        <button type="button" class="btn btn-outline btn-sm range-btn" data-range="-7d"${actionAttrs('switchVitalsHistoryRange', [patientId, safeName, '-7d'], { element: true })} style="padding: 4px 10px; font-size: 11px; font-weight: 600;">7d</button>
        <button type="button" class="btn btn-outline btn-sm range-btn" data-range="-30d"${actionAttrs('switchVitalsHistoryRange', [patientId, safeName, '-30d'], { element: true })} style="padding: 4px 10px; font-size: 11px; font-weight: 600;" title="The last 30 days">30d</button>
      </div>
      <div style="display: flex; gap: 6px;">
        <button type="button" class="btn btn-outline btn-sm" onclick="downloadVitalsCsv()" title="Every reading of this period, for Excel">⬇ CSV</button>
        <button type="button" class="btn btn-outline btn-sm" onclick="printVitalsReport()" title="A report of this period to print or save as PDF">🖨 Print / PDF</button>
      </div>
    </div>

    <!-- Dynamic Container for stats, charts, and table -->
    <div id="vitals-history-dynamic-container" style="min-height: 380px;">
      <div style="text-align: center; padding: 48px; color: var(--text-muted);">
        <div style="font-size: 24px; margin-bottom: 8px;">⏳</div>
        <div>Loading the vitals of ${escapeHtml(safeName)}…</div>
      </div>
    </div>
  `;

  if (window.showModal) {
    window.showModal({
      title: 'Vitals history',
      customHtml: modalHtml,
      isWide: true,
      type: 'info',
      confirmText: 'Close'
    });
  }

  // Load initial range data
  await switchVitalsHistoryRange(patientId, safeName, defaultRange);
}

/**
 * Handles time range switching, queries /api/patients/vitals-history, and renders charts
 */
async function switchVitalsHistoryRange(patientId, patientName, range, clickedBtn = null) {
  const container = document.getElementById('vitals-history-dynamic-container');
  if (!container) return;

  // Update active button state
  const pills = document.querySelectorAll('#vitals-range-pills .range-btn');
  pills.forEach(b => {
    b.className = 'btn btn-outline btn-sm range-btn';
  });
  if (clickedBtn) {
    clickedBtn.className = 'btn btn-primary btn-sm range-btn';
  } else {
    const defaultBtn = document.querySelector(`#vitals-range-pills .range-btn[data-range="${CSS.escape(String(range))}"]`);
    if (defaultBtn) defaultBtn.className = 'btn btn-primary btn-sm range-btn';
  }

  container.innerHTML = `
    <div style="text-align: center; padding: 48px; color: var(--text-muted);">
      <div style="font-size: 24px; margin-bottom: 8px;">⏳</div>
      <div>Loading…</div>
    </div>
  `;

  try {
    const res = await fetch(`/api/patients/vitals-history?id=${encodeURIComponent(patientId)}&range=${encodeURIComponent(range)}`);
    const data = await res.json();

    lastVitalsReport = { patientId, patientName, range, vitals: data.success && Array.isArray(data.vitals) ? data.vitals : [] };
    if (!data.success || !Array.isArray(data.vitals) || data.vitals.length === 0) {
      container.innerHTML = `
        <div style="background: #F8FAFC; border: 1px dashed var(--border); border-radius: 8px; padding: 36px 20px; text-align: center; margin-top: 10px;">
          <div style="font-size: 32px; margin-bottom: 8px;">📊</div>
          <div style="font-weight: 700; color: var(--text-primary); font-size: 15px;">No vitals in this period</div>
          <div style="font-size: 13px; color: var(--text-muted); max-width: 520px; margin: 8px auto 14px auto; line-height: 1.5;">
            Vitals are saved while the patient wears a linked wristband: one measurement every 3 minutes, or every second in live mode.
          </div>
          <div style="display: flex; gap: 8px; justify-content: center; font-size: 11px;">
            <span class="badge badge-info">Patient: ${escapeHtml(patientId)}</span>
            <span class="badge badge-neutral">Wristband: ${escapeHtml(data.device_id || 'none linked')}</span>
          </div>
        </div>
      `;
      return;
    }

    const vitals = data.vitals;

    // Filter valid numeric HR and SpO2
    const validHR = vitals.map(v => v.heart_rate).filter(h => h !== null && h > 0);
    const validSpO2 = vitals.map(v => v.spo2).filter(s => s !== null && s > 0);

    const minHR = validHR.length > 0 ? Math.min(...validHR) : '--';
    const maxHR = validHR.length > 0 ? Math.max(...validHR) : '--';
    const avgHR = validHR.length > 0 ? Math.round(validHR.reduce((a, b) => a + b, 0) / validHR.length) : '--';

    const minSpO2 = validSpO2.length > 0 ? Math.min(...validSpO2) : '--';
    const maxSpO2 = validSpO2.length > 0 ? Math.max(...validSpO2) : '--';
    const avgSpO2 = validSpO2.length > 0 ? (validSpO2.reduce((a, b) => a + b, 0) / validSpO2.length).toFixed(1) : '--';

    // Build SVG Trend Charts
    const hrSvg = generateVitalsSvg(vitals, 'heart_rate', 40, 160, 60, 100, '#DC2626', '#22C55E', 'BPM');
    const spo2Svg = generateVitalsSvg(vitals, 'spo2', 75, 100, 95, 100, '#0284C7', '#0EA5E9', '%');
    Object.assign(lastVitalsReport, { hrSvg, spo2Svg, avgHR, minHR, maxHR, avgSpO2, minSpO2, maxSpO2 });

    container.innerHTML = `
      <!-- 4-Card Summary KPI Strip -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 14px;">
        <div style="background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; padding: 10px 12px;">
          <div style="font-size: 11px; font-weight: 600; color: #991B1B;">❤️ Average heart rate</div>
          <div style="font-size: 20px; font-weight: 800; color: #DC2626; margin-top: 2px;">
            ${avgHR} <span style="font-size: 11px; font-weight: 500;">BPM</span>
          </div>
          <div style="font-size: 10px; color: #B91C1C; margin-top: 2px;">Min: ${minHR} · Max: ${maxHR}</div>
        </div>

        <div style="background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 8px; padding: 10px 12px;">
          <div style="font-size: 11px; font-weight: 600; color: #166534;">🫁 Average SpO2 (indicative)</div>
          <div style="font-size: 20px; font-weight: 800; color: #15803D; margin-top: 2px;">
            ${avgSpO2}<span style="font-size: 11px; font-weight: 500;">%</span>
          </div>
          <div style="font-size: 10px; color: #166534; margin-top: 2px;">Min: ${minSpO2}% · Max: ${maxSpO2}%</div>
        </div>

        <div style="background: #F8FAFC; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;">
          <div style="font-size: 11px; font-weight: 600; color: var(--text-secondary);">📊 Readings shown</div>
          <div style="font-size: 20px; font-weight: 800; color: var(--text-primary); margin-top: 2px;">
            ${vitals.length}
          </div>
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;" title="Each point is the middle value (median) of the readings in one interval; an interval without a reading has no point.">One value per ${escapeHtml(data.window || 'interval')}</div>
        </div>

        <div style="background: #F0F9FF; border: 1px solid #BAE6FD; border-radius: 8px; padding: 10px 12px;">
          <div style="font-size: 11px; font-weight: 600; color: #0369A1;">🗓 Kept for</div>
          <div style="font-size: 14px; font-weight: 700; color: #0284C7; margin-top: 4px;">
            30 days
          </div>
          <div style="font-size: 10px; color: #0284C7; margin-top: 2px;">Older than 7 days: fewer points</div>
        </div>
      </div>

      <!-- Trend Chart 1: Heart Rate (BPM) -->
      <div style="background: #FFFFFF; border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="font-size: 12px; font-weight: 700; color: #991B1B;">❤️ Heart rate (bpm)</div>
          <div style="font-size: 10px; color: var(--text-muted);">
            <span style="display: inline-block; width: 10px; height: 10px; background: #DCFCE7; border: 1px solid #86EFAC; border-radius: 2px; margin-right: 4px; vertical-align: middle;"></span>
            Normal: 60–100 bpm
          </div>
        </div>
        ${hrSvg}
      </div>

      <!-- Trend Chart 2: Blood Oxygen SpO2 (%) -->
      <div style="background: #FFFFFF; border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="font-size: 12px; font-weight: 700; color: #0369A1;">🫁 SpO2 (%, indicative)</div>
          <div style="font-size: 10px; color: var(--text-muted);">
            <span style="display: inline-block; width: 10px; height: 10px; background: #E0F2FE; border: 1px solid #7DD3FC; border-radius: 2px; margin-right: 4px; vertical-align: middle;"></span>
            Normal: 95–100%
          </div>
        </div>
        ${spo2Svg}
      </div>

      <!-- Compact Recent Point Log -->
      <details style="font-size: 11px; color: var(--text-secondary); margin-top: 6px;">
        <summary style="cursor: pointer; font-weight: 600; padding: 4px 0; color: var(--primary);">
          📋 The latest ${Math.min(vitals.length, 10)} readings (of ${vitals.length})
        </summary>
        <div style="max-height: 140px; overflow-y: auto; margin-top: 6px; border: 1px solid var(--border); border-radius: 6px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
            <thead>
              <tr style="background: #F8FAFC; border-bottom: 1px solid var(--border); text-align: left;">
                <th style="padding: 6px 10px;">Time</th>
                <th style="padding: 6px 10px;">Heart rate</th>
                <th style="padding: 6px 10px;">SpO2</th>
              </tr>
            </thead>
            <tbody>
              ${vitals.slice(-10).reverse().map(v => {
                const d = new Date(v.time);
                const timeStr = d.toLocaleTimeString() + ' (' + d.toLocaleDateString() + ')';
                return `
                  <tr style="border-bottom: 1px solid #F1F5F9;">
                    <td style="padding: 4px 10px;" class="mono">${timeStr}</td>
                    <td style="padding: 4px 10px; font-weight: 600; color: ${v.heart_rate > 100 || v.heart_rate < 50 ? '#DC2626' : '#15803D'};">${escapeHtml(v.heart_rate || '--')} BPM</td>
                    <td style="padding: 4px 10px; font-weight: 600; color: ${v.spo2 < 94 ? '#DC2626' : '#0369A1'};">${escapeHtml(v.spo2 ? v.spo2 + '%' : '--')}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </details>
    `;

  } catch (err) {
    container.innerHTML = `
      <div style="padding: 24px; text-align: center; color: var(--danger);">
        The vitals could not be loaded: ${escapeHtml(err.message)}
      </div>
    `;
  }
}

/**
 * Generates an SVG line graph with normal range shading and interactive data points
 */
function generateVitalsSvg(points, field, minAxis, maxAxis, normalLow, normalHigh, strokeColor, normalBgColor, unit) {
  const w = 680;
  const h = 130;
  const padLeft = 45;
  const padRight = 20;
  const padTop = 15;
  const padBottom = 22;

  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const validPoints = points.filter(p => p[field] !== null && p[field] !== undefined && p[field] > 0);
  if (validPoints.length === 0) {
    return `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:11px;">No valid ${field} data points in this window.</div>`;
  }

  const getY = (val) => padTop + plotH - ((Math.min(maxAxis, Math.max(minAxis, val)) - minAxis) / (maxAxis - minAxis)) * plotH;
  const getX = (idx) => padLeft + (validPoints.length > 1 ? (idx / (validPoints.length - 1)) * plotW : plotW / 2);

  // Normal zone band coordinates
  const yNormalTop = getY(normalHigh);
  const yNormalBottom = getY(normalLow);
  const normalBandH = Math.max(2, yNormalBottom - yNormalTop);

  // Generate SVG path polyline
  let pathD = '';
  const circles = [];

  validPoints.forEach((p, idx) => {
    const x = getX(idx);
    const y = getY(p[field]);
    if (idx === 0) pathD += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
    else pathD += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;

    const isAbnormal = p[field] < normalLow || p[field] > normalHigh;
    const dotColor = isAbnormal ? '#DC2626' : strokeColor;
    const timeLabel = new Date(p.time).toLocaleString();
    circles.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${validPoints.length > 50 ? 2 : 3.5}" fill="${dotColor}" stroke="#FFFFFF" stroke-width="1.5"><title>${escapeHtml(timeLabel)}: ${escapeHtml(p[field])} ${unit}</title></circle>`);
  });

  // Generate Y-axis gridlines
  const yGridVals = [minAxis, normalLow, normalHigh, maxAxis];
  const gridLines = yGridVals.map(val => {
    const y = getY(val);
    return `
      <line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${w - padRight}" y2="${y.toFixed(1)}" stroke="#E2E8F0" stroke-width="1" stroke-dasharray="3,3" />
      <text x="${padLeft - 6}" y="${(y + 3.5).toFixed(1)}" font-size="9" text-anchor="end" fill="#64748B">${val}</text>
    `;
  }).join('');

  // Time axis: start, middle and end; with the date when the period is longer than a day
  const firstT = new Date(validPoints[0].time).getTime();
  const lastT = new Date(validPoints[validPoints.length - 1].time).getTime();
  const withDate = lastT - firstT > 20 * 3600 * 1000;
  const axisText = (t) => withDate
    ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const startTimeStr = axisText(firstT);
  const endTimeStr = axisText(lastT);
  const midTimeStr = axisText((firstT + lastT) / 2);

  return `
    <svg viewBox="0 0 ${w} ${h}" style="width: 100%; height: auto; display: block; overflow: visible;">
      <!-- Normal Range Shaded Box -->
      <rect x="${padLeft}" y="${yNormalTop.toFixed(1)}" width="${plotW}" height="${normalBandH.toFixed(1)}" fill="${normalBgColor}" opacity="0.18" rx="2" />
      
      <!-- Gridlines -->
      ${gridLines}

      <!-- Data Trend Line -->
      <path d="${pathD}" fill="none" stroke="${strokeColor}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />

      <!-- Data Point Circles -->
      ${circles.join('')}

      <!-- X-Axis Labels -->
      <text x="${padLeft}" y="${h - 4}" font-size="9" fill="#64748B">${startTimeStr}</text>
      <text x="${w - padRight}" y="${h - 4}" font-size="9" text-anchor="end" fill="#64748B">${endTimeStr}</text>
      <text x="${(padLeft + (w - padRight)) / 2}" y="${h - 4}" font-size="9" text-anchor="middle" fill="#64748B">${escapeHtml(midTimeStr)}</text>
    </svg>
  `;
}

// Global exports for inline HTML event handlers and SPA router
// ----- Vitals: download and print (Phase 11) -----
let lastVitalsReport = null;
const VITALS_RANGE_TEXT = { '-1h': 'the last hour', '-6h': 'the last 6 hours', '-24h': 'the last 24 hours', '-7d': 'the last 7 days', '-30d': 'the last 30 days' };
const pad2 = (n) => String(n).padStart(2, '0');
const localStamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

/** Every reading of the shown period as a CSV file for Excel (UTF-8, local times, empty = not measured). */
function downloadVitalsCsv() {
  const r = lastVitalsReport;
  if (!r || !r.vitals.length) {
    if (window.showToast) window.showToast('No vitals in this period to download.', 'info');
    return;
  }
  const lines = ['Time (local),Heart rate (bpm),SpO2 (%; indicative)'];
  for (const v of r.vitals) {
    const hr = v.heart_rate > 0 ? String(Math.round(v.heart_rate)) : '';
    const spo2 = v.spo2 > 0 ? String(Number(v.spo2)) : '';
    lines.push(`${localStamp(v.time)},${hr},${spo2}`);
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vitals_${r.patientId}_${r.range.replace('-', '')}_${localStamp(Date.now()).replace(/[-: ]/g, '').slice(0, 12)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** A one-page report of the shown period: who, when, summary, both charts, the latest readings. */
function printVitalsReport() {
  const r = lastVitalsReport;
  if (!r || !r.vitals.length) {
    if (window.showToast) window.showToast('No vitals in this period to print.', 'info');
    return;
  }
  const win = window.open('', '_blank');
  if (!win) {
    if (window.showToast) window.showToast('The browser blocked the report window. Allow pop-ups for this page.', 'warning');
    return;
  }
  const by = window.shiroAuth && window.shiroAuth.user ? window.shiroAuth.user.full_name : '';
  const first = localStamp(r.vitals[0].time);
  const last = localStamp(r.vitals[r.vitals.length - 1].time);
  const latest = r.vitals.slice(-100).reverse();
  const readingRows = latest.map(v => `<tr><td>${escapeHtml(localStamp(v.time))}</td><td>${escapeHtml(v.heart_rate > 0 ? Math.round(v.heart_rate) : '–')}</td><td>${escapeHtml(v.spo2 > 0 ? v.spo2 : '–')}</td></tr>`).join('');
  const hrSvg = r.hrSvg || '';
  const spo2Svg = r.spo2Svg || '';
  win.document.write(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Vitals ${escapeHtml(r.patientId)}</title>
<style>
  body { font-family: "Segoe UI", Arial, sans-serif; color: #0F172A; margin: 24px; font-size: 13px; }
  h1 { font-size: 20px; margin: 0 0 4px; } .meta { color: #475569; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #CBD5E1; padding: 4px 8px; text-align: left; }
  th { background: #F1F5F9; } .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 14px 0; }
  .note { color: #64748B; font-size: 12px; margin-top: 6px; } @media print { .noprint { display: none; } }
</style></head><body>
  <button class="noprint" onclick="window.print()" style="float: right; padding: 6px 14px;">Print / Save as PDF</button>
  <h1>Vitals report: ${escapeHtml(r.patientName || r.patientId)} (${escapeHtml(r.patientId)})</h1>
  <div class="meta">Period: ${escapeHtml(VITALS_RANGE_TEXT[r.range] || r.range)}, readings from ${escapeHtml(first)} to ${escapeHtml(last)} · ${Number(r.vitals.length)} readings · printed ${escapeHtml(localStamp(Date.now()))}${escapeHtml(by ? ' by ' + by : '')}</div>
  <table><tr><th></th><th>Average</th><th>Lowest</th><th>Highest</th></tr>
    <tr><td>Heart rate (bpm)</td><td>${escapeHtml(r.avgHR)}</td><td>${escapeHtml(r.minHR)}</td><td>${escapeHtml(r.maxHR)}</td></tr>
    <tr><td>SpO2 (%, indicative: not calibrated)</td><td>${escapeHtml(r.avgSpO2)}</td><td>${escapeHtml(r.minSpO2)}</td><td>${escapeHtml(r.maxSpO2)}</td></tr>
  </table>
  <div class="charts"><div><b>Heart rate (bpm)</b>${hrSvg}</div><div><b>SpO2 (%)</b>${spo2Svg}</div></div>
  <b>Latest readings</b>${escapeHtml(r.vitals.length > 100 ? ' (the newest 100; every reading is in the CSV download)' : '')}
  <table><tr><th>Time</th><th>Heart rate (bpm)</th><th>SpO2 (%)</th></tr>${readingRows}</table>
  <div class="note">Measured by the SHIRO wristband. SpO2 is indicative only and raises no alarm.</div>
</body></html>`);
  win.document.close();
  win.focus();
}

window.downloadVitalsCsv = downloadVitalsCsv;
window.printVitalsReport = printVitalsReport;
window.initPatientsModule = initPatientsModule;
window.toggleAdmissionForm = toggleAdmissionForm;
window.handlePatientAdmission = handlePatientAdmission;
window.handlePhotoFileUpload = handlePhotoFileUpload;
window.selectAvatarPreset = selectAvatarPreset;
window.handleNameOrDobChange = handleNameOrDobChange;
window.handleSexChange = handleSexChange;
window.handleNricInput = handleNricInput;
window.clearValidation = clearValidation;
window.handleWardSelectionChange = handleWardSelectionChange;
window.setPatientFilter = setPatientFilter;
window.filterPatientTable = filterPatientTable;
window.confirmDischargePatient = confirmDischargePatient;
window.confirmDeletePatient = confirmDeletePatient;
window.openAssignBedModal = openAssignBedModal;
window.viewPatientProfileReadOnly = viewPatientProfileReadOnly;
window.editPatientInfo = editPatientInfo;
window.resetAdmissionForm = resetAdmissionForm;
window.openPatientVitalsHistoryModal = openPatientVitalsHistoryModal;
window.switchVitalsHistoryRange = switchVitalsHistoryRange;

// Wire automatic initialization when document loads or tab switches
document.addEventListener('DOMContentLoaded', () => {
  const patientsTab = document.getElementById('tab-patients');
  if (patientsTab && patientsTab.classList.contains('active')) {
    initPatientsModule();
  }
});

// =============================================================================
// Height and weight (optional): an empty field means "not recorded"
// =============================================================================

/** Reads two optional inputs. Returns { height_cm, weight_kg } (null when empty) or { error }. */
function readBodyMeasurements(heightId, weightId) {
  const hText = (document.getElementById(heightId)?.value || '').trim();
  const wText = (document.getElementById(weightId)?.value || '').trim();
  let height_cm = null;
  let weight_kg = null;
  if (hText !== '') {
    height_cm = Number(hText);
    if (!Number.isInteger(height_cm) || height_cm < 40 || height_cm > 230) {
      return { error: 'Height must be a whole number of cm between 40 and 230, or empty.' };
    }
  }
  if (wText !== '') {
    weight_kg = Number(wText);
    if (!Number.isFinite(weight_kg) || weight_kg < 2 || weight_kg > 300) {
      return { error: 'Weight must be between 2 and 300 kg, or empty.' };
    }
    weight_kg = Math.round(weight_kg * 10) / 10;
  }
  return { height_cm, weight_kg };
}

/** "165 cm · 58.5 kg", with "not recorded" for a missing value. */
function bodySummary(p) {
  const h = p.height_cm === null || p.height_cm === undefined ? 'not recorded' : `${p.height_cm} cm`;
  const w = p.weight_kg === null || p.weight_kg === undefined ? 'not recorded' : `${p.weight_kg} kg`;
  return `${h} · ${w}`;
}
