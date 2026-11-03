// =============================================================================
// Bindings Controller: Patient-Tag Association Wizard & Tracking Links
// =============================================================================

function handleBindingSubmit(e) {
  if (e) e.preventDefault();
  const patientSelect = document.getElementById('bind-patient-select');
  const tagSelect = document.getElementById('bind-tag-select');

  const patient = patientSelect ? patientSelect.value : 'P-102';
  const tag = tagSelect ? tagSelect.value : 'TAG-003';

  showModal({
    title: 'Confirm Patient-Device Binding',
    message: `Pair and bind patient [${patient}] with wearable sensor [${tag}]?\n\nReal-time indoor location tracking and vital signs telemetry will immediately link to this patient record.`,
    type: 'info',
    confirmText: 'Pair Devices',
    cancelText: 'Cancel',
    onConfirm: () => {
      showToast(`Successfully paired Patient ${patient} with ${tag}!`, 'success');
    }
  });
}

function updateBindingPatientPreview() {
  const select = document.getElementById('bind-patient-select');
  if (!select) return;
  const val = select.value;
  const nameEl = document.getElementById('prev-patient-name');
  const metaEl = document.getElementById('prev-patient-meta');
  const riskEl = document.getElementById('prev-patient-risk');

  if (!nameEl || !metaEl || !riskEl) return;

  if (val === 'P-102') {
    nameEl.innerText = 'Siti Nurhaliza';
    metaEl.innerText = 'ID: P-102 | Bed: BED-A1-02 | Age: 54 / F';
    riskEl.innerText = '● MEDIUM FALL RISK';
    riskEl.className = 'badge badge-warning';
  } else {
    nameEl.innerText = 'Wong Wai Keat';
    metaEl.innerText = 'ID: P-104 | Bed: BED-A1-04 | Age: 41 / M';
    riskEl.innerText = '● LOW FALL RISK';
    riskEl.className = 'badge badge-live';
  }
}

function unbindTag(btn, name) {
  showModal({
    title: 'Unbind Wearable Tag',
    message: `Unbind wearable wristband from patient "${name}"?\n\nReal-time telemetry streaming will be paused.`,
    type: 'danger',
    confirmText: 'Unbind Tag',
    cancelText: 'Cancel',
    onConfirm: () => {
      if (btn) {
        const row = btn.closest('tr');
        if (row) row.remove();
      }
      showToast(`Tag unbound from ${name}.`, 'info');
    }
  });
}

// Global exposure
window.handleBindingSubmit = handleBindingSubmit;
window.updateBindingPatientPreview = updateBindingPatientPreview;
window.unbindTag = unbindTag;

