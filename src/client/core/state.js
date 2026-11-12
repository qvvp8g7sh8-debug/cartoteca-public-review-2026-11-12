function createState() {
  const state = {};
  state.KEY = 'cosmetology-card-demo-v1';
  state.seed = [
    {
      id: 'p1',
      name: 'Анна Морозова',
      phone: '+7 900 000-12-34',
      birth: '1989-04-17',
      allergies: '',
      notes: 'Предпочитает вечерние визиты.',
      appointments: [
        {
          id: 'a1',
          date: '2026-09-15',
          time: '11:00',
          service: 'Консультация',
          notes: '',
        },
      ],
      visits: [
        {
          id: 'v1',
          date: '2026-09-15',
          procedure: 'Консультация',
          notes: 'Обсудили план следующих встреч.',
          photos: [],
        },
      ],
    },
    {
      id: 'p2',
      name: 'Елена Соколова',
      phone: '+7 900 000-56-78',
      birth: '1992-11-03',
      allergies: '',
      notes: 'Предпочитает связь через сообщения.',
      appointments: [],
      visits: [],
    },
    {
      id: 'p3',
      name: 'Мария Ким',
      phone: '+7 900 000-90-12',
      birth: '1986-06-25',
      allergies: '',
      notes: '',
      appointments: [],
      visits: [],
    },
  ];
  state.data = [];
  state.directory = [];
  state.lazyReads = false;
  state.pagedReads = false;
  state.calendarRecords = [];
  state.calendarOverview = null;
  state.personalEvents = [];
  state.personalRevision = 0;
  state.calendarPersonalOverview = null;
  state.account = null;
  state.sessionReady = false;
  state.startupStatus = 'idle';
  state.settingsReady = false;
  state.settingsBundleId = '';
  state.assistantScope = null;
  state.assistantReady = false;
  state.assistantBundleId = '';
  state.assistantGeneration = 0;
  state.assistantEditor = null;
  state.revision = 0;
  state.busy = false;
  state.multiUser = false;
  state.timeZone = 'Europe/Moscow';
  state.teamAccess = null;
  state.workspace = {
    revision: 0,
    enabled: false,
    staffRules: [],
    mode: 'separate',
    rooms: [],
    members: [],
    canEdit: false,
    canEditStaffRules: false,
    canEditRoomAssignments: false,
    canEditRoomOverlap: false,
  };
  state.roomBusy = [];
  state.roomCacheKey = '';
  state.selectedRoomId = '';
  state.selectedScheduleStaff = '';
  state.calendarGrouping = 'staff';
  state.calendarLoadGrouping = 'staff';
  state.calendarLoadPeriod = 'week';
  state.calendarLoadReturnMode = 'day';
  state.selectedId = null;
  state.activeTab = 'visits';
  state.currentView = 'calendar';
  state.clientFilter = 'appointment';
  state.patientSort = 'first';
  state.appointmentFromServices = false;
  state.calendarAnchorDate = new Date();
  state.calendarAnchorDate.setHours(0, 0, 0, 0);
  state.mobileScreen = window.matchMedia?.('(max-width: 700px)');
  state.phoneLandscape = false;
  state.calendarMode = 'day';
  state.monthPickerOpen = false;
  state.showEarlyHours = false;
  state.editorMode = null;
  state.uploadItems = [];
  state.SERVICE_KEY = 'cosmetology-services-v1';
  state.serviceSeed = [
    {
      id: 's1',
      name: 'Консультация',
      category: 'other',
      duration: '90 минут',
      product: '',
      price: 3800,
    },
    {
      id: 's2',
      name: 'Индивидуальная встреча',
      category: 'other',
      duration: '45 минут',
      product: '',
      price: 2500,
    },
    {
      id: 's3',
      name: 'Основная услуга',
      category: 'other',
      duration: '60 минут',
      product: '',
      price: 8000,
    },
    {
      id: 's4',
      name: 'Расширенная услуга',
      category: 'other',
      duration: '75 минут',
      product: '',
      price: 12000,
    },
    {
      id: 's5',
      name: 'Индивидуальное занятие',
      category: 'other',
      duration: '60 минут',
      product: '',
      price: 3200,
    },
    {
      id: 's6',
      name: 'Консультация',
      category: 'other',
      duration: '30 минут',
      product: '',
      price: 1500,
    },
  ];
  state.SERVICE_CATEGORIES = [
    { id: 'other', title: 'Без группы', description: 'Услуги без группы' },
  ];
  state.LEGACY_SERVICE_CATEGORIES = structuredClone(state.SERVICE_CATEGORIES);
  state.serviceGroupRevision = 0;
  state.services = [];
  state.serviceCatalogOwnerId = '';
  state.roleNames = {
    owner: 'Владелец',
    salon_admin: 'Администратор',
    cosmetologist: 'Сотрудник',
  };
  state.printGeneration = 0;
  state.printJob = null;
  return state;
}
