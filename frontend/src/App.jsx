import { useCallback, useEffect, useState } from 'react';

const apiUrl = (import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? 'http://localhost:3000' : window.location.origin)).replace(/\/$/, '');
const directSlideUpload = import.meta.env.VITE_DIRECT_SLIDE_UPLOAD === 'true';

async function responseData(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Nao foi possivel concluir a operacao.');
  }
  return data;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'long',
    timeStyle: 'short'
  }).format(new Date(value));
}

function App() {
  const [apiStatus, setApiStatus] = useState({ state: 'loading', message: 'Verificando conexao...' });
  const [seminars, setSeminars] = useState([]);
  const [seminarsError, setSeminarsError] = useState('');
  const [formMessage, setFormMessage] = useState('');
  const [savingSeminar, setSavingSeminar] = useState(false);
  const [presenters, setPresenters] = useState(['']);
  const [deletingSeminarId, setDeletingSeminarId] = useState(null);
  const [seminarActionMessage, setSeminarActionMessage] = useState('');
  const [selectedSeminar, setSelectedSeminar] = useState(null);
  const [seminarPresenters, setSeminarPresenters] = useState([]);
  const [presentersLoading, setPresentersLoading] = useState(false);
  const [presentersError, setPresentersError] = useState('');
  const [updatingPresenterId, setUpdatingPresenterId] = useState(null);
  const [attendanceMessage, setAttendanceMessage] = useState('');

  const loadSeminars = useCallback(async (signal) => {
    try {
      const response = await fetch(`${apiUrl}/api/seminars`, { signal });
      const loadedSeminars = await responseData(response);
      setSeminars(loadedSeminars);
      setSelectedSeminar((current) => current
        ? loadedSeminars.find((seminar) => seminar.id === current.id) || null
        : null);
      setSeminarsError('');
      setApiStatus({ state: 'up', message: 'API e banco conectados' });
    } catch (error) {
      if (error.name !== 'AbortError') {
        setSeminarsError(error.message || 'Nao foi possivel carregar os seminarios.');
        setApiStatus({ state: 'down', message: 'Nao foi possivel conectar a API' });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/health`, { signal: controller.signal })
      .then(async (response) => {
        const data = await responseData(response);
        setApiStatus({ state: 'up', message: `Servicos conectados · ${data.cloud}` });
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          setApiStatus({ state: 'down', message: 'Nao foi possivel conectar a API' });
        }
      });
    loadSeminars(controller.signal);
    return () => controller.abort();
  }, [loadSeminars]);

  async function handleCreateSeminar(event) {
    event.preventDefault();
    setSavingSeminar(true);
    setFormMessage('');

    const form = event.currentTarget;
    const formData = new FormData(form);
    formData.delete('presenters');
    const seminarPresenters = presenters.map((presenter) => presenter.trim()).filter(Boolean);
    seminarPresenters.forEach((presenter) => formData.append('presenters', presenter));
    const dateTime = formData.get('startsAt');
    if (dateTime) {
      formData.set('startsAt', new Date(dateTime).toISOString());
    }

    try {
      if (directSlideUpload && formData.get('slides') instanceof File &&
          formData.get('slides').size > 0) {
        const slides = formData.get('slides');
        const upload = await responseData(await fetch(`${apiUrl}/api/slides/uploads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: slides.type, size: slides.size })
        }));
        const uploadForm = new FormData();
        Object.entries(upload.fields).forEach(([name, value]) => uploadForm.append(name, value));
        uploadForm.append('file', slides);
        const uploadResponse = await fetch(upload.url, { method: 'POST', body: uploadForm });
        if (!uploadResponse.ok) {
          throw new Error('Nao foi possivel enviar os slides ao armazenamento.');
        }

        const seminar = Object.fromEntries(formData.entries());
        delete seminar.slides;
        seminar.presenters = seminarPresenters;
        seminar.slidesKey = upload.key;
        if (dateTime) {
          seminar.startsAt = new Date(dateTime).toISOString();
        }
        await responseData(await fetch(`${apiUrl}/api/seminars`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(seminar)
        }));
      } else {
        await responseData(await fetch(`${apiUrl}/api/seminars`, {
          method: 'POST',
          body: formData
        }));
      }
      form.reset();
      setPresenters(['']);
      setFormMessage('Seminario cadastrado com sucesso.');
      await loadSeminars();
    } catch (error) {
      setFormMessage(error.message || 'Nao foi possivel cadastrar o seminario.');
    } finally {
      setSavingSeminar(false);
    }
  }

  async function openSeminarDetails(seminar) {
    setSelectedSeminar(seminar);
    setSeminarPresenters([]);
    setPresentersError('');
    setAttendanceMessage('');
    setPresentersLoading(true);
    try {
      const response = await fetch(`${apiUrl}/api/seminars/${seminar.id}/presenters`);
      setSeminarPresenters(await responseData(response));
    } catch (error) {
      setPresentersError(error.message || 'Nao foi possivel carregar os apresentadores.');
    } finally {
      setPresentersLoading(false);
    }
  }

  async function handlePresenterAttendance(presenter, isPresent) {
    setUpdatingPresenterId(presenter.id);
    setAttendanceMessage('');
    try {
      const updatedPresenter = await responseData(await fetch(
        `${apiUrl}/api/seminars/${selectedSeminar.id}/presenters/${presenter.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isPresent })
        }
      ));
      setSeminarPresenters((current) => current.map((item) =>
        item.id === updatedPresenter.id ? updatedPresenter : item
      ));
      setAttendanceMessage(`${updatedPresenter.name}: ${updatedPresenter.is_present ? 'presenca confirmada' : 'marcado como ausente'}.`);
      await loadSeminars();
    } catch (error) {
      setAttendanceMessage(error.message || 'Nao foi possivel atualizar a presenca.');
    } finally {
      setUpdatingPresenterId(null);
    }
  }

  async function handleDeleteSeminar(seminar) {
    if (!window.confirm(`Tem certeza que deseja apagar o seminario "${seminar.title}"? Esta acao nao pode ser desfeita.`)) {
      return;
    }

    setDeletingSeminarId(seminar.id);
    setSeminarActionMessage('');
    try {
      const response = await fetch(`${apiUrl}/api/seminars/${seminar.id}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Nao foi possivel apagar o seminario.');
      }
      setSeminarActionMessage(`O seminario "${seminar.title}" foi apagado.`);
      await loadSeminars();
    } catch (error) {
      setSeminarActionMessage(error.message || 'Nao foi possivel apagar o seminario.');
      await loadSeminars();
    } finally {
      setDeletingSeminarId(null);
    }
  }

  return (
    <main className="page">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Mural de Seminarios, inicio">
          <span className="brand-mark" aria-hidden="true">M</span>
          <span>mural<span className="brand-light">.</span></span>
        </a>
        <span className="topbar-label">COMUNIDADE ACADEMICA</span>
      </header>

      <section className="hero">
        <p className="eyebrow"><span className="eyebrow-line" /> IDEIAS QUE MERECEM SER COMPARTILHADAS</p>
        <h1>Conhecimento<br />em <span>movimento.</span></h1>
        <p className="intro">
          Cadastre seminarios, compartilhe slides e registre sua presenca em um so lugar.
        </p>
        <div className={`status-pill status-${apiStatus.state}`} aria-live="polite">
          <span className="status-dot" />
          {apiStatus.message}
        </div>
      </section>

      <section className="section-block create-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">COMPARTILHE CONHECIMENTO</p>
            <h2>Cadastrar seminario</h2>
          </div>
        </div>
        <form className="seminar-form" onSubmit={handleCreateSeminar}>
          <label className="field field-wide">
            <span>Titulo do seminario</span>
            <input name="title" maxLength="200" required placeholder="Ex.: Inteligencia artificial na educacao" />
          </label>
          <label className="field">
            <span>Apresentadores <small>ate 10 pessoas</small></span>
            <div className="presenter-fields">
              {presenters.map((presenter, index) => (
                <div className="presenter-field-row" key={index}>
                  <input
                    name="presenters"
                    maxLength="200"
                    required={index === 0}
                    placeholder={`Nome do apresentador${index + 1 > 1 ? ` ${index + 1}` : ''}`}
                    value={presenter}
                    onChange={(event) => setPresenters((current) =>
                      current.map((name, currentIndex) => currentIndex === index ? event.target.value : name)
                    )}
                  />
                  {presenters.length > 1 && (
                    <button
                      className="remove-presenter-button"
                      type="button"
                      aria-label={`Remover apresentador ${index + 1}`}
                      onClick={() => setPresenters((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {presenters.length < 10 && (
                <button
                  className="add-presenter-button"
                  type="button"
                  onClick={() => setPresenters((current) => [...current, ''])}
                >
                  + Adicionar apresentador
                </button>
              )}
            </div>
          </label>
          <label className="field">
            <span>Local</span>
            <input name="location" maxLength="200" required placeholder="Sala ou link da reuniao" />
          </label>
          <label className="field">
            <span>Data e horario</span>
            <input name="startsAt" type="datetime-local" required />
          </label>
          <label className="field">
            <span>Slides em PDF <small>opcional · ate 10 MB</small></span>
            <input name="slides" type="file" accept="application/pdf,.pdf" />
          </label>
          <label className="field field-wide">
            <span>Descricao <small>opcional</small></span>
            <textarea name="description" rows="3" maxLength="5000" placeholder="Um resumo do tema e do que sera apresentado." />
          </label>
          <div className="form-actions">
            <button className="submit-button" type="submit" disabled={savingSeminar}>
              {savingSeminar ? 'Salvando...' : 'Publicar seminario'} <span aria-hidden="true">→</span>
            </button>
            <p className="form-feedback" role="status">{formMessage}</p>
          </div>
        </form>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <p className="section-kicker">AGENDA DA TURMA</p>
            <h2>Proximos seminarios</h2>
          </div>
          <span className="count-badge">{seminars.length} {seminars.length === 1 ? 'seminario' : 'seminarios'}</span>
        </div>

        {seminarsError && <p className="message message-error" role="alert">{seminarsError}</p>}
        {seminarActionMessage && <p className="message" role="status">{seminarActionMessage}</p>}
        {!seminarsError && seminars.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon" aria-hidden="true">✳</span>
            <strong>A agenda esta livre por enquanto.</strong>
            <span>Cadastre o primeiro seminario logo abaixo.</span>
          </div>
        )}

        <div className="seminar-list">
          {seminars.map((seminar) => (
            <article className="seminar-card" key={seminar.id}>
              <div className="seminar-main">
                <div className="seminar-date">{formatDate(seminar.starts_at)}</div>
                <h3>{seminar.title}</h3>
                <p className="seminar-presenter">
                  Com {seminar.presenters.join(', ')} <span>·</span> {seminar.location}
                </p>
                {seminar.description && <p className="seminar-description">{seminar.description}</p>}
                <div className="seminar-meta">
                  <span>{seminar.attendance_count} {seminar.attendance_count === 1 ? 'presenca' : 'presencas'}</span>
                  {seminar.has_slides && (
                    <a className="slides-link" href={`${apiUrl}/api/seminars/${seminar.id}/slides`}>
                      Baixar slides PDF <span aria-hidden="true">↓</span>
                    </a>
                  )}
                  <button
                    className="delete-seminar-button"
                    type="button"
                    disabled={deletingSeminarId === seminar.id}
                    onClick={() => handleDeleteSeminar(seminar)}
                  >
                    {deletingSeminarId === seminar.id ? 'Apagando...' : 'Apagar seminario'}
                  </button>
                </div>
              </div>
              <button
                className="seminar-details-button"
                type="button"
                onClick={() => openSeminarDetails(seminar)}
              >
                Detalhes e presenca <span aria-hidden="true">→</span>
              </button>
            </article>
          ))}
        </div>
      </section>

      <footer className="footer">
        <span>MURAL DE SEMINARIOS</span>
        <span>FEITO PARA TROCAR IDEIAS <span className="footer-star">✳</span></span>
      </footer>

      {selectedSeminar && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedSeminar(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSelectedSeminar(null);
          }}
        >
          <section className="seminar-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <button
              className="modal-close"
              type="button"
              aria-label="Fechar detalhes do seminario"
              autoFocus
              onClick={() => setSelectedSeminar(null)}
            >
              ×
            </button>
            <p className="section-kicker">DETALHES DO SEMINARIO</p>
            <h2 id="modal-title">{selectedSeminar.title}</h2>
            <div className="modal-details">
              <p><strong>Data e horario</strong><span>{formatDate(selectedSeminar.starts_at)}</span></p>
              <p><strong>Apresentadores</strong><span>{selectedSeminar.presenters.join(', ')}</span></p>
              <p><strong>Local</strong><span>{selectedSeminar.location}</span></p>
              <p><strong>Apresentadores presentes</strong><span>{selectedSeminar.attendance_count} de {seminarPresenters.length}</span></p>
            </div>
            <div className="modal-description">
              <h3>Sobre o seminario</h3>
              <p>{selectedSeminar.description || 'Nenhuma descricao detalhada foi informada.'}</p>
            </div>
            {selectedSeminar.has_slides && (
              <a className="slides-link modal-slides" href={`${apiUrl}/api/seminars/${selectedSeminar.id}/slides`}>
                Baixar slides PDF <span aria-hidden="true">↓</span>
              </a>
            )}
            <div className="modal-attendance">
              <div className="participant-heading">
                <span className="attendance-title">Presenca dos apresentadores</span>
                <span className="attendance-note">Selecione presente ou ausente para cada apresentador.</span>
              </div>
              {presentersError && <p className="message message-error" role="alert">{presentersError}</p>}
              {attendanceMessage && <p className="form-feedback" role="status">{attendanceMessage}</p>}
              {presentersLoading ? (
                <p className="attendance-note">Carregando apresentadores...</p>
              ) : seminarPresenters.length === 0 ? (
                <p className="no-presenters">Este seminario nao tem apresentadores cadastrados.</p>
              ) : (
                <div className="presenter-attendance-table" role="table" aria-label="Presenca dos apresentadores">
                  <div className="presenter-attendance-header" role="row">
                    <span role="columnheader">Apresentador</span>
                    <span role="columnheader">Presenca</span>
                  </div>
                  {seminarPresenters.map((presenter) => (
                    <div className="presenter-attendance-row" role="row" key={presenter.id}>
                      <span className="participant-name" role="cell">{presenter.name}</span>
                      <label className="sr-only" htmlFor={`presenter-attendance-${presenter.id}`}>
                        Presenca de {presenter.name}
                      </label>
                      <select
                        id={`presenter-attendance-${presenter.id}`}
                        className={`presenter-attendance-select ${presenter.is_present ? 'is-present' : ''}`}
                        role="cell"
                        value={presenter.is_present ? 'present' : 'absent'}
                        disabled={updatingPresenterId === presenter.id}
                        onChange={(event) => handlePresenterAttendance(
                          presenter,
                          event.target.value === 'present'
                        )}
                      >
                        <option value="absent">Ausente</option>
                        <option value="present">Presente</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
