// =============================================================================
// Clinical Modern Modal & Toast Notification System
// =============================================================================
function showModal({
  title,
  message,
  customHtml = null,
  isWide = false,
  type = 'info',
  confirmText = 'Confirm',
  cancelText = null,
  onConfirm = null,
  onCancel = null
}) {
  const backdrop = document.getElementById('custom-modal-backdrop');
  const box = document.getElementById('custom-modal-box');
  const titleEl = document.getElementById('modal-title');
  const bodyEl = document.getElementById('modal-body');
  const iconEl = document.getElementById('modal-icon');
  const btnConfirm = document.getElementById('modal-btn-confirm');
  const btnCancel = document.getElementById('modal-btn-cancel');
  const btnClose = document.getElementById('modal-btn-close');

  if (!backdrop) return;

  if (box) {
    if (isWide) {
      box.classList.add('modal-wide');
    } else {
      box.classList.remove('modal-wide');
    }
  }

  titleEl.innerText = title;
  if (customHtml) {
    bodyEl.innerHTML = customHtml;
  } else {
    bodyEl.innerText = message || '';
  }

  let iconText = 'ℹ️';
  let iconClass = 'icon-info';
  if (type === 'success') { iconText = '✅'; iconClass = 'icon-success'; }
  else if (type === 'danger') { iconText = '🗑️'; iconClass = 'icon-danger'; }
  else if (type === 'warning') { iconText = '⚠️'; iconClass = 'icon-warning'; }

  iconEl.innerText = iconText;
  iconEl.className = `modal-icon ${iconClass}`;

  btnConfirm.innerText = confirmText;
  if (type === 'danger') {
    btnConfirm.className = 'btn btn-danger-outline btn-sm';
  } else {
    btnConfirm.className = 'btn btn-primary btn-sm';
  }

  if (cancelText) {
    btnCancel.style.display = 'inline-block';
    btnCancel.innerText = cancelText;
  } else {
    btnCancel.style.display = 'none';
  }

  const close = () => {
    backdrop.classList.remove('active');
    if (box) box.classList.remove('modal-wide');
    btnConfirm.onclick = null;
    btnCancel.onclick = null;
    if (btnClose) btnClose.onclick = null;
  };

  btnConfirm.onclick = () => {
    close();
    if (onConfirm) onConfirm();
  };

  btnCancel.onclick = () => {
    close();
    if (onCancel) onCancel();
  };

  if (btnClose) {
    btnClose.onclick = () => {
      close();
      if (onCancel) onCancel();
    };
  }

  backdrop.classList.add('active');
}

function showToast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('custom-toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast-pill toast-${type}`;
  const icon = type === 'success' ? '✅' : (type === 'danger' ? '❌' : (type === 'warning' ? '⚠️' : 'ℹ️'));
  toast.innerHTML = `<span style="font-size:16px;">${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Ensure global accessibility across all modules and inline handlers
window.showModal = showModal;
window.showToast = showToast;

