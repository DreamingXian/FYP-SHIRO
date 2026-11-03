// =============================================================================
// SHIRO Hospital Edge Admin - Patients Controller
// Client-side Controller for Inpatient Admissions, Photo Upload, Bed Sync & Census
// =============================================================================

let currentPatientFilter = 'ALL';
let cachedPatients = [];
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

  if (!file.type.startsWith('image/')) {
    if (window.showToast) window.showToast('Please select a valid image file (JPG, PNG, WebP).', 'warning');
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
  let optionsHtml = `<option value="">-- None / Unassigned --</option>`;

  if (cachedWards && cachedWards.length > 0) {
    optionsHtml += cachedWards.map(w => 
      `<option value="${w.ward_id}">${w.ward_id} - ${w.room_title}</option>`
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
    bedSelect.innerHTML = `<option value="">-- None / Unassigned --</option>`;
    bedSelect.disabled = true;
    return;
  }

  bedSelect.disabled = false;
  const available = cachedAvailableBeds.filter(b => b.ward_id === selectedWardId);

  if (available.length === 0) {
    bedSelect.innerHTML = `<option value="" disabled selected>⚠️ No available beds in this ward (All Occupied / Unavailable)</option>`;
  } else {
    bedSelect.innerHTML = available.map(b => 
      `<option value="${b.bed_id}">🟢 ${b.bed_code} (${b.bed_id}) - Available</option>`
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
    const res = await fetch(`/api/patients/list?status=${currentPatientFilter}`);
    const data = await res.json();

    if (data.success) {
      cachedPatients = data.patients || [];
      renderPatientsTable(cachedPatients);
      updateCensusCounts();
    } else {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--danger); padding:24px;">Failed to load patients: ${data.error || 'Server error'}</td></tr>`;
    }
  } catch (err) {
    console.error('Failed to load patients directory:', err);
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--danger); padding:24px;">Network error loading patients from edge server.</td></tr>`;
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

  if (admittedBadge) admittedBadge.innerText = `${admittedCount} Admitted`;
  if (dischargedBadge) dischargedBadge.innerText = `${dischargedCount} Discharged`;
}

/**
 * Renders the patient records table with separated Age and Sex columns and clickable rows.
 */
function renderPatientsTable(patients) {
  const tbody = document.getElementById('patients-table-body');
  if (!tbody) return;

  if (!patients || patients.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:32px; color:var(--text-muted);">
      No inpatient records found matching current criteria.
    </td></tr>`;
    return;
  }

  tbody.innerHTML = patients.map(p => {
    // Photo or initials fallback
    const initials = p.full_name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    const photoImg = p.photo_url 
      ? `<img src="${p.photo_url}" alt="${p.full_name}" onerror="this.onerror=null; this.parentElement.innerText='${initials}'">`
      : initials;

    // Fall risk badge
    let riskBadge = `<span class="badge badge-live">● LOW RISK</span>`;
    if (p.fall_risk_score === 'MEDIUM') riskBadge = `<span class="badge badge-warning">● MEDIUM</span>`;
    if (p.fall_risk_score === 'HIGH') riskBadge = `<span class="badge badge-alert">● HIGH RISK</span>`;

    // Bed and Ward info
    const bedInfo = p.status === 'ADMITTED' && p.assigned_bed_id
      ? `<span class="badge badge-info">${p.assigned_ward_id} · ${p.bed_code || p.assigned_bed_id}</span>`
      : `<span class="badge badge-neutral">No Active Bed</span>`;

    // Status pill
    const statusBadge = p.status === 'ADMITTED'
      ? `<span class="badge badge-live">● Admitted</span>`
      : `<span class="badge badge-neutral">● Discharged</span>`;

    // Discharge / Assign Bed Action button
    let secondaryActionBtn = '';
    if (p.status === 'ADMITTED' && p.assigned_bed_id) {
      secondaryActionBtn = `<button class="btn btn-danger-outline btn-sm" onclick="event.stopPropagation(); confirmDischargePatient('${p.patient_id}', '${p.full_name.replace(/'/g, "\\'")}', '${p.assigned_ward_id ? p.assigned_ward_id + ' · ' + (p.bed_code || p.assigned_bed_id) : 'assigned bed'}')">Discharge</button>`;
    } else {
      secondaryActionBtn = `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); openAssignBedModal('${p.patient_id}')">Assign Bed</button>`;
    }

    const genderLabel = p.gender === 'FEMALE' ? 'Female' : p.gender === 'MALE' ? 'Male' : 'Other';

    return `
      <tr class="table-row-clickable" onclick="viewPatientProfileReadOnly('${p.patient_id}')" title="Click to view full clinical profile for ${p.full_name}">
        <td>
          <div class="patient-cell">
            <div class="patient-thumb" title="${p.full_name}">
              ${photoImg}
            </div>
            <div>
              <div style="font-weight: 600; color: var(--text-primary);">${p.full_name}</div>
              <div class="mono" style="font-size: 11px; color: var(--primary); font-weight: 600;">${p.patient_id}</div>
            </div>
          </div>
        </td>
        <td class="mono">${p.nric_passport}</td>
        <td>${p.age !== null ? p.age + ' yrs' : '-'}</td>
        <td><span class="badge badge-neutral" style="font-size: 11px;">${genderLabel}</span></td>
        <td>${bedInfo}</td>
        <td>${riskBadge}</td>
        <td style="color: var(--text-secondary); font-size: 12px;">${p.admission_date || '-'}</td>
        <td>${statusBadge}</td>
        <td style="text-align: right; white-space: nowrap;">
          <button class="btn btn-outline btn-sm" onclick="event.stopPropagation(); editPatientInfo('${p.patient_id}')" style="margin-right: 4px;">Edit Infos</button>
          ${secondaryActionBtn}
          <button class="btn btn-danger-outline btn-sm" onclick="event.stopPropagation(); confirmDeletePatient('${p.patient_id}', '${p.full_name.replace(/'/g, "\\'")}')" title="Delete record" style="margin-left: 4px;">🗑️</button>
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
  document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  loadPatientsDirectory();
}

/**
 * Real-time search filter across patient name, ID, NRIC, bed, or ward.
 */
function filterPatientTable() {
  const input = document.getElementById('patient-search-input');
  if (!input) return;
  const q = input.value.trim().toLowerCase();

  if (!q) {
    renderPatientsTable(cachedPatients);
    return;
  }

  const filtered = cachedPatients.filter(p => {
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
  if (!nameVal || !/^[a-zA-Z\s\.\'\-\@\/]{2,}$/.test(nameVal)) {
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
  const cleanPhone = phoneVal.replace(/[-\s\(\)\+]/g, '');
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
  const risk = document.querySelector('input[name="fall_risk"]:checked').value;
  const history = document.getElementById('adm-history').value.trim();
  let photoUrl = document.getElementById('adm-photo-url').value;

  const hasBedAssignment = wardId && bedId;
  let confirmTitle = '';
  let confirmMessage = '';
  let confirmButtonText = '';

  if (hasBedAssignment) {
    const wardOption = document.querySelector(`#adm-ward option[value="${wardId}"]`);
    const bedOption = document.querySelector(`#adm-bed option[value="${bedId}"]`);
    const wardTitle = wardOption ? wardOption.innerText : wardId;
    const bedTitle = bedOption ? bedOption.innerText : bedId;

    confirmTitle = 'Confirm Patient Admission';
    confirmMessage = `Admit patient "${name}" (${id}, NRIC: ${nric}) to:\n\n• Unit: ${wardTitle}\n• Bed: ${bedTitle}\n• Fall Risk Level: ${risk}\n\nThis will mark the cubicle bed as OCCUPIED in MySQL.`;
    confirmButtonText = '➕ Confirm Admission to Bed';
  } else {
    confirmTitle = 'Register Patient Without Bed Assignment';
    confirmMessage = `Admit patient "${name}" (${id}, NRIC: ${nric}) WITHOUT an assigned hospital bed cubicle?\n\nThis patient will be registered as an Inpatient / Observation case without an active bed reservation. A bed can be assigned later via the census table.`;
    confirmButtonText = '➕ Register Without Bed Assignment';
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
            if (uploadData.success && uploadData.photo_url) {
              photoUrl = uploadData.photo_url;
            }
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
            fall_risk_score: risk,
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
              window.showToast(`Patient ${name} (${result.patient_id}) registered successfully!`, 'success');
            }
            resetAdmissionForm();
            // Refresh data
            await Promise.all([
              fetchNextPatientId(),
              fetchAvailableBedsAndWards(),
              loadPatientsDirectory()
            ]);
          } else {
            if (window.showModal) {
              window.showModal({
                title: 'Registration Failed',
                message: result.error || 'Failed to admit patient into MySQL.',
                type: 'danger',
                confirmText: 'OK',
                cancelText: null
              });
            }
          }
        } catch (err) {
          console.error('Admission error:', err);
          if (window.showToast) window.showToast('Network error during patient admission.', 'danger');
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
    window.showModal({
      title: 'Discharge Inpatient',
      message: `Are you sure you want to discharge "${patientName}" (${patientId})?\n\nThis will update the patient status to DISCHARGED and automatically release ${bedInfo} back to AVAILABLE for new admissions.`,
      type: 'danger',
      confirmText: 'Discharge Patient',
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
      title: 'Delete Patient Record',
      message: `Are you sure you want to permanently delete patient "${patientName}" (${patientId}) from MySQL database?\n\nIf the patient is currently assigned to a bed, the bed will automatically be released back to AVAILABLE. This action cannot be undone.`,
      type: 'danger',
      confirmText: '🗑️ Delete Permanently',
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
async function openAssignBedModal(patientId) {
  try {
    const res = await fetch(`/api/patients/get?id=${patientId}`);
    const data = await res.json();
    if (!data.success || !data.patient) {
      if (window.showToast) window.showToast('Patient record not found.', 'warning');
      return;
    }
    const p = data.patient;

    // Refresh available beds list
    const bedsRes = await fetch('/api/patients/available-beds');
    const bedsData = await bedsRes.json();
    const wards = bedsData.wards || [];
    const availableBeds = bedsData.availableBeds || [];

    if (availableBeds.length === 0) {
      if (window.showModal) {
        window.showModal({
          title: 'No Available Beds',
          message: 'All hospital beds across all configured wards are currently OCCUPIED or UNAVAILABLE.\n\nPlease discharge a patient or add beds in Ward Config first.',
          type: 'warning',
          confirmText: 'OK',
          cancelText: null
        });
      }
      return;
    }

    const wardOptions = wards.map(w => `<option value="${w.ward_id}">${w.ward_id} - ${w.room_title}</option>`).join('');

    const modalContent = `
      <div style="font-size:13px; color:var(--text-secondary); margin-bottom:14px;">
        Assigning active bed cubicle for <strong>${p.full_name}</strong> (${p.patient_id}, NRIC: ${p.nric_passport}).
      </div>
      <div class="form-group">
        <label class="form-label">Target Ward Unit *</label>
        <select class="form-control" id="modal-assign-ward" onchange="updateAssignBedModalBeds()">
          ${wardOptions}
        </select>
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label">Available Bed Cubicle *</label>
        <select class="form-control" id="modal-assign-bed">
        </select>
      </div>
    `;

    window._modalAvailableBeds = availableBeds;
    window.updateAssignBedModalBeds = function() {
      const wardEl = document.getElementById('modal-assign-ward');
      const bedEl = document.getElementById('modal-assign-bed');
      if (!wardEl || !bedEl) return;
      const filtered = window._modalAvailableBeds.filter(b => b.ward_id === wardEl.value);
      if (filtered.length === 0) {
        bedEl.innerHTML = `<option value="" disabled selected>No available beds in this ward</option>`;
      } else {
        bedEl.innerHTML = filtered.map(b => `<option value="${b.bed_id}">🟢 ${b.bed_code} (${b.bed_id})</option>`).join('');
      }
    };

    if (window.showModal) {
      window.showModal({
        title: `Assign Bed Cubicle: ${p.full_name}`,
        customHtml: modalContent,
        type: 'info',
        confirmText: 'Assign & Occupy Bed',
        cancelText: 'Cancel',
        onConfirm: async () => {
          const wardId = document.getElementById('modal-assign-ward')?.value;
          const bedId = document.getElementById('modal-assign-bed')?.value;

          if (!wardId || !bedId) {
            if (window.showToast) window.showToast('Please select a valid available bed.', 'warning');
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
              if (window.showToast) window.showToast(`Bed successfully assigned to ${p.full_name}!`, 'success');
              await Promise.all([
                fetchAvailableBedsAndWards(),
                loadPatientsDirectory()
              ]);
            } else {
              if (window.showToast) window.showToast(`Assignment failed: ${assignResult.error}`, 'danger');
            }
          } catch (err) {
            console.error('Assign bed error:', err);
            if (window.showToast) window.showToast('Network error assigning bed.', 'danger');
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
    const res = await fetch(`/api/patients/get?id=${patientId}`);
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
        <img src="${photoSrc}" alt="${p.full_name}" style="width:76px; height:76px; border-radius:50%; object-fit:cover; border:3px solid var(--primary); box-shadow:0 3px 10px rgba(0,0,0,0.1);">
        <div>
          <div style="font-size:18px; font-weight:700; color:var(--text-primary);">${p.full_name}</div>
          <div style="font-size:12px; color:var(--primary); font-weight:600;" class="mono">${p.patient_id} · NRIC: ${p.nric_passport}</div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:3px;">
            ${p.age} yrs · ${genderLabel} · DOB: ${p.dob} · 📞 ${p.phone_number}
          </div>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; background:#F8FAFC; border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:14px; font-size:12px;">
        <div>
          <span style="color:var(--text-muted);">Assigned Location:</span><br>
          <strong style="color:var(--text-primary);">${bedDesc}</strong>
        </div>
        <div>
          <span style="color:var(--text-muted);">Fall Risk Level:</span><br>
          <strong style="color:${p.fall_risk_score === 'HIGH' ? 'var(--danger)' : p.fall_risk_score === 'MEDIUM' ? 'var(--warning)' : 'var(--success)'};">● ${p.fall_risk_score} RISK</strong>
        </div>
        <div>
          <span style="color:var(--text-muted);">Admission Timestamp:</span><br>
          <span style="color:var(--text-secondary);">${p.admission_date || '-'}</span>
        </div>
        <div>
          <span style="color:var(--text-muted);">Status:</span><br>
          <strong style="color:${p.status === 'ADMITTED' ? 'var(--success)' : 'var(--text-muted)'};">${p.status}</strong>
        </div>
      </div>

      <div style="font-size:12px; background:#FFFFFF; border:1px solid var(--border); border-radius:8px; padding:12px;">
        <div style="font-weight:600; color:var(--text-primary); margin-bottom:6px;">Medical History, Chronic Conditions &amp; Drug Allergies:</div>
        <div style="color:var(--text-secondary); line-height:1.5; white-space:pre-wrap;">${p.medical_history || 'No recorded chronic illnesses or known drug allergies.'}</div>
      </div>
    `;

    if (window.showModal) {
      window.showModal({
        title: `Patient Clinical Profile (Read-Only)`,
        customHtml: modalContent,
        type: 'info',
        confirmText: 'Close',
        cancelText: null
      });
    }
  } catch (err) {
    console.error('View read-only profile error:', err);
  }
}

/**
 * Opens "Edit Infos" modal where ONLY Phone, Fall Risk, and Notes can be modified,
 * with confirmation prompt on saving changes.
 */
async function editPatientInfo(patientId) {
  try {
    const res = await fetch(`/api/patients/get?id=${patientId}`);
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

      if (!file.type.startsWith('image/')) {
        if (window.showToast) window.showToast('Please select a valid image file (JPG, PNG, WebP).', 'warning');
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
          <img id="edit-patient-photo-preview" src="${photoSrc}" alt="${p.full_name}" style="width:68px; height:68px; border-radius:50%; object-fit:cover; border:2.5px solid var(--primary); box-shadow:0 2px 8px rgba(0,0,0,0.12);">
        </div>
        <div style="flex:1;">
          <div style="font-size:16px; font-weight:700; color:var(--text-primary);">${p.full_name}</div>
          <div style="font-size:11px; color:var(--primary); font-weight:600;" class="mono">${p.patient_id} · NRIC: ${p.nric_passport}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
            ${p.age !== null ? p.age + ' yrs' : '-'} · ${genderLabel} · DOB: ${p.dob} · Location: ${bedDesc}
          </div>
          
          <!-- Photo Re-upload / Preset Select Bar -->
          <div style="margin-top:8px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <input type="file" id="edit-patient-photo-file" accept="image/*" style="display:none;" onchange="handleEditPhotoFileUpload(event)">
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
          <input type="hidden" id="edit-patient-photo-url" value="${photoSrc}">
        </div>
      </div>

      <div style="border-top:1px solid var(--border); padding-top:12px;">
        <div class="form-group">
          <label class="form-label" style="font-weight:600;">Emergency Contact Phone *</label>
          <input type="text" class="form-control" id="edit-patient-phone" value="${p.phone_number || ''}" placeholder="+6012-3456789">
        </div>

        <div class="form-group">
          <label class="form-label" style="font-weight:600;">Clinical Fall Risk Stratification *</label>
          <div class="radio-pills">
            <label class="radio-pill-item">
              <input type="radio" name="edit_fall_risk" value="LOW" ${p.fall_risk_score === 'LOW' ? 'checked' : ''}>
              <span class="radio-pill-label risk-low">● LOW RISK</span>
            </label>
            <label class="radio-pill-item">
              <input type="radio" name="edit_fall_risk" value="MEDIUM" ${p.fall_risk_score === 'MEDIUM' ? 'checked' : ''}>
              <span class="radio-pill-label risk-med">● MEDIUM</span>
            </label>
            <label class="radio-pill-item">
              <input type="radio" name="edit_fall_risk" value="HIGH" ${p.fall_risk_score === 'HIGH' ? 'checked' : ''}>
              <span class="radio-pill-label risk-high">● HIGH RISK</span>
            </label>
          </div>
        </div>

        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label" style="font-weight:600;">Medical History, Chronic Conditions &amp; Drug Allergies</label>
          <textarea id="edit-patient-history" class="form-control" rows="3" style="font-size:12px;">${p.medical_history || ''}</textarea>
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
          const updatedRisk = document.querySelector('input[name="edit_fall_risk"]:checked')?.value || p.fall_risk_score;
          const updatedHistory = document.getElementById('edit-patient-history')?.value.trim();
          let updatedPhoto = document.getElementById('edit-patient-photo-url')?.value || photoSrc;

          // Validation
          if (!updatedPhone || !/^(\+?6?01[0-9]{1}-?[0-9]{7,8}|\+?[0-9\s\-]{8,15})$/.test(updatedPhone)) {
            if (window.showToast) window.showToast('Please enter a valid phone number before saving.', 'warning');
            return;
          }

          // Confirmation prompt before saving notes / changes
          window.showModal({
            title: 'Confirm Changes',
            message: `Save updated clinical information for "${p.full_name}" (${p.patient_id})?\n\n• Phone: ${updatedPhone}\n• Fall Risk: ${updatedRisk}\n• Photo: ${updatedPhoto !== photoSrc ? 'Updated' : 'Unchanged'}`,
            type: 'info',
            confirmText: '💾 Save Changes',
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
                  if (uploadData.success && uploadData.photo_url) {
                    updatedPhoto = uploadData.photo_url;
                  }
                }

                const updateRes = await fetch('/api/patients/update', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    patient_id: p.patient_id,
                    phone_number: updatedPhone,
                    fall_risk_score: updatedRisk,
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

  // Reset Fall Risk radio to LOW
  const lowRiskRadio = document.querySelector('input[name="fall_risk"][value="LOW"]');
  if (lowRiskRadio) lowRiskRadio.checked = true;

  handleNameOrDobChange();

  // Restore next patient ID & Ward
  fetchNextPatientId();
  populateWardDropdown();
  handleWardSelectionChange();
}

// Global exports for inline HTML event handlers and SPA router
window.initPatientsModule = initPatientsModule;
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

// Wire automatic initialization when document loads or tab switches
document.addEventListener('DOMContentLoaded', () => {
  const patientsTab = document.getElementById('tab-patients');
  if (patientsTab && patientsTab.classList.contains('active')) {
    initPatientsModule();
  }
});
