/**
 * Reference structure of PUET used to seed a fresh database.
 * After go-live the No-Code Admin Panel (Phase 2) and ЄДЕБО/HR sync own this data.
 *
 * NOTE: the department list below must be verified against the current official
 * list of PUET departments before production seeding.
 */
import type { E2eeMode, OrgUnitKind, TenantCode } from '@prisma/client';

export interface TenantSeed {
  code: TenantCode;
  nameUk: string;
  nameEn: string;
  city: string;
  minorProtected: boolean;
}

export const TENANTS: TenantSeed[] = [
  {
    code: 'PUET_MAIN',
    nameUk: 'Полтавський університет економіки і торгівлі',
    nameEn: 'Poltava University of Economics and Trade',
    city: 'Полтава',
    minorProtected: false,
  },
  {
    code: 'PUET_LYCEUM',
    nameUk: 'Ліцей ПУЕТ',
    nameEn: 'PUET Lyceum',
    city: 'Полтава',
    minorProtected: true,
  },
  {
    code: 'COLLEGE_POLTAVA',
    nameUk: 'Полтавський фаховий коледж ПУЕТ',
    nameEn: 'Poltava Professional College of PUET',
    city: 'Полтава',
    minorProtected: false,
  },
  {
    code: 'COLLEGE_CHERKASY',
    nameUk: 'Черкаський кооперативний економіко-правовий фаховий коледж ПУЕТ',
    nameEn: 'Cherkasy Cooperative Professional College of Economics and Law of PUET',
    city: 'Черкаси',
    minorProtected: false,
  },
  {
    code: 'COLLEGE_BILHOROD',
    nameUk: 'Білгород-Дністровський економіко-правовий фаховий коледж ПУЕТ',
    nameEn: 'Bilhorod-Dnistrovskyi Professional College of Economics and Law of PUET',
    city: 'Білгород-Дністровський',
    minorProtected: false,
  },
];

export interface NamedSeed {
  code: string;
  nameUk: string;
  nameEn: string;
}

/** Administrative vertical: 7 institutes (ННІ) of PUET_MAIN. */
export const INSTITUTES: (NamedSeed & { bilingualUi?: boolean })[] = [
  { code: 'NNI_DAYTIME', nameUk: 'ННІ денної освіти', nameEn: 'Institute of Daytime Education' },
  {
    code: 'NNI_DISTANCE',
    nameUk: 'ННІ заочно-дистанційного навчання',
    nameEn: 'Institute of Extramural and Distance Learning',
  },
  {
    code: 'NNI_INTERNATIONAL',
    nameUk: 'ННІ міжнародної освіти',
    nameEn: 'Institute of International Education',
    bilingualUi: true,
  },
  { code: 'NNI_LEADERSHIP', nameUk: 'ННІ лідерства', nameEn: 'Institute of Leadership' },
  {
    code: 'NNI_PROJECTS',
    nameUk: 'ННІ проєктів та підвищення кваліфікації',
    nameEn: 'Institute of Projects and Professional Development',
  },
  {
    code: 'NNI_SOCIAL_LABOR',
    nameUk: 'ННІ соціально-трудових відносин',
    nameEn: 'Institute of Social and Labor Relations',
  },
  {
    code: 'NNI_INNOVATIVE_MGMT',
    nameUk: 'ННІ інноваційних технологій управління',
    nameEn: 'Institute of Innovative Management Technologies',
  },
];

/** Academic vertical: 17 cross-institute departments (кафедри). Verify before production. */
export const DEPARTMENTS: NamedSeed[] = [
  { code: 'ACCOUNTING_AUDIT', nameUk: 'Кафедра обліку і аудиту', nameEn: 'Department of Accounting and Audit' },
  { code: 'FINANCE_BANKING', nameUk: 'Кафедра фінансів та банківської справи', nameEn: 'Department of Finance and Banking' },
  {
    code: 'INTL_ECONOMICS',
    nameUk: 'Кафедра міжнародної економіки та міжнародних економічних відносин',
    nameEn: 'Department of International Economics and International Economic Relations',
  },
  {
    code: 'COMPUTER_SCIENCE_IT',
    nameUk: 'Кафедра комп’ютерних наук та інформаційних технологій',
    nameEn: 'Department of Computer Science and Information Technologies',
  },
  { code: 'LAW', nameUk: 'Кафедра права', nameEn: 'Department of Law' },
  { code: 'MANAGEMENT', nameUk: 'Кафедра менеджменту', nameEn: 'Department of Management' },
  { code: 'MARKETING', nameUk: 'Кафедра маркетингу', nameEn: 'Department of Marketing' },
  {
    code: 'HOTEL_RESTAURANT',
    nameUk: 'Кафедра готельного і ресторанного бізнесу',
    nameEn: 'Department of Hotel and Restaurant Business',
  },
  { code: 'FOOD_TECHNOLOGIES', nameUk: 'Кафедра харчових технологій', nameEn: 'Department of Food Technologies' },
  {
    code: 'COMMODITY_SCIENCE',
    nameUk: 'Кафедра товарознавства, біотехнологій, експертизи та митної справи',
    nameEn: 'Department of Commodity Science, Biotechnology, Expertise and Customs',
  },
  {
    code: 'ECONOMIC_THEORY',
    nameUk: 'Кафедра економічної теорії та економічної кібернетики',
    nameEn: 'Department of Economic Theory and Economic Cybernetics',
  },
  {
    code: 'MATH_MODELING',
    nameUk: 'Кафедра математичного моделювання та соціальної інформатики',
    nameEn: 'Department of Mathematical Modeling and Social Informatics',
  },
  { code: 'TOURISM', nameUk: 'Кафедра туризму', nameEn: 'Department of Tourism' },
  {
    code: 'LANGUAGES_TRANSLATION',
    nameUk: 'Кафедра української, іноземних мов та перекладу',
    nameEn: 'Department of Ukrainian, Foreign Languages and Translation',
  },
  {
    code: 'PUBLIC_ADMINISTRATION',
    nameUk: 'Кафедра публічного управління та адміністрування',
    nameEn: 'Department of Public Administration',
  },
  {
    code: 'TRADE_LOGISTICS',
    nameUk: 'Кафедра торговельного підприємництва та логістики',
    nameEn: 'Department of Trade Entrepreneurship and Logistics',
  },
  {
    code: 'PEDAGOGY_PSYCHOLOGY_PE',
    nameUk: 'Кафедра педагогіки, психології та фізичного виховання',
    nameEn: 'Department of Pedagogy, Psychology and Physical Education',
  },
];

export interface OrgUnitSeed extends NamedSeed {
  kind: OrgUnitKind;
  parent?: string;
  confidential?: boolean;
  e2eeMode?: E2eeMode;
  anonymousIntake?: boolean;
  bypassesQuietHours?: boolean;
  forbidExternalForward?: boolean;
}

export const ORG_UNITS: OrgUnitSeed[] = [
  // Governance
  { code: 'RECTORATE', kind: 'GOVERNANCE', nameUk: 'Ректорат', nameEn: 'Rectorate', e2eeMode: 'MANDATORY' },
  { code: 'ACADEMIC_COUNCIL', kind: 'GOVERNANCE', nameUk: 'Вчена рада', nameEn: 'Academic Council', confidential: true },
  {
    code: 'SCI_METHOD_COUNCIL',
    kind: 'GOVERNANCE',
    nameUk: 'Науково-методична рада',
    nameEn: 'Scientific and Methodological Council',
  },
  // Admin & services
  { code: 'CHANCELLERY', kind: 'ADMIN_SERVICE', nameUk: 'Канцелярія', nameEn: 'Chancellery', forbidExternalForward: true },
  { code: 'HR', kind: 'ADMIN_SERVICE', nameUk: 'Відділ кадрів', nameEn: 'Human Resources', confidential: true, forbidExternalForward: true },
  {
    code: 'FINANCE',
    kind: 'ADMIN_SERVICE',
    nameUk: 'Фінансово-економічне управління',
    nameEn: 'Finance and Economics Office',
    confidential: true,
    forbidExternalForward: true,
  },
  { code: 'LEGAL', kind: 'ADMIN_SERVICE', nameUk: 'Юрисконсульт', nameEn: 'Legal Office', confidential: true, forbidExternalForward: true },
  { code: 'ADMISSIONS', kind: 'ADMIN_SERVICE', nameUk: 'Приймальна комісія', nameEn: 'Admissions Office' },
  {
    code: 'QUALITY_ASSURANCE',
    kind: 'ADMIN_SERVICE',
    nameUk: 'Центр забезпечення якості вищої освіти',
    nameEn: 'Higher Education Quality Assurance Center',
  },
  { code: 'STUDENT_DOCS', kind: 'ADMIN_SERVICE', nameUk: 'Відділ студентської документації', nameEn: 'Student Records Office' },
  { code: 'ARCHIVE', kind: 'ADMIN_SERVICE', nameUk: 'Архів', nameEn: 'Archive' },
  {
    code: 'SCI_ORG_DEPT',
    kind: 'ADMIN_SERVICE',
    nameUk: 'Науково-організаційний відділ',
    nameEn: 'Research Organization Office',
  },
  { code: 'IT_CENTER', kind: 'ADMIN_SERVICE', nameUk: 'Інформаційний центр', nameEn: 'Information Center' },
  {
    code: 'EDEBO_AUTOMATION',
    kind: 'ADMIN_SERVICE',
    nameUk: 'Відділ по автоматизації та по роботі з ЄДЕБО',
    nameEn: 'Automation and EDEBO Office',
  },
  { code: 'MARKETING_DEPT', kind: 'ADMIN_SERVICE', nameUk: 'Департамент маркетингу', nameEn: 'Marketing Department' },
  // Academic centers
  { code: 'STEAM_HUB', kind: 'ACADEMIC_CENTER', nameUk: 'ННЦ «STEAM-ХАБ»', nameEn: 'STEAM-HUB' },
  { code: 'INTERLINGUA', kind: 'ACADEMIC_CENTER', nameUk: 'Тренінгова академія «Інтерлінгва»', nameEn: 'Interlingua Training Academy' },
  {
    code: 'PHD_TRAINING_CENTER',
    kind: 'ACADEMIC_CENTER',
    nameUk: 'ННЦ підготовки кадрів вищої кваліфікації',
    nameEn: 'Center for Postgraduate Training',
  },
  {
    code: 'INTL_EDU_CENTER',
    kind: 'ACADEMIC_CENTER',
    nameUk: 'Міжнародний науково-освітній центр',
    nameEn: 'International Scientific and Educational Center',
  },
  // Trust & safety (mandatory E2EE)
  {
    code: 'OMBUDSMAN',
    kind: 'TRUST_SERVICE',
    nameUk: 'Офіс студентського омбудсмена',
    nameEn: 'Student Ombudsman Office',
    e2eeMode: 'MANDATORY',
    anonymousIntake: true,
  },
  {
    code: 'PSYCHOLOGICAL_SERVICE',
    kind: 'TRUST_SERVICE',
    nameUk: 'Психологічна служба',
    nameEn: 'Psychological Service',
    e2eeMode: 'MANDATORY',
    anonymousIntake: true,
  },
  {
    code: 'MILITARY_REGISTRATION',
    kind: 'TRUST_SERVICE',
    nameUk: 'Відділ військового обліку та бронювання',
    nameEn: 'Military Registration and Mobilization Office',
    e2eeMode: 'MANDATORY',
    confidential: true,
  },
  {
    code: 'CIVIL_PROTECTION',
    kind: 'SAFETY_SERVICE',
    nameUk: 'Підрозділ цивільного захисту',
    nameEn: 'Civil Protection Unit',
    bypassesQuietHours: true,
  },
  // Facilities (АГР)
  { code: 'AHR', kind: 'FACILITIES', nameUk: 'Адміністративно-господарська робота', nameEn: 'Administrative and Facilities Services' },
  { code: 'AHR_BUILDINGS', kind: 'FACILITIES', parent: 'AHR', nameUk: 'Експлуатація будівель', nameEn: 'Building Operations' },
  { code: 'AHR_HEAT_POWER', kind: 'FACILITIES', parent: 'AHR', nameUk: 'Теплоенергетика', nameEn: 'Heat and Power' },
  { code: 'AHR_LABOR_SAFETY', kind: 'FACILITIES', parent: 'AHR', nameUk: 'Охорона праці', nameEn: 'Labor Safety' },
  { code: 'AHR_TRANSPORT', kind: 'FACILITIES', parent: 'AHR', nameUk: 'Транспорт', nameEn: 'Transport' },
  // Campus
  { code: 'STUDENT_CAMPUS', kind: 'CAMPUS', nameUk: 'Студентське містечко', nameEn: 'Student Campus' },
  // Community
  { code: 'STUDENT_GOVERNMENT', kind: 'COMMUNITY', nameUk: 'Студентське самоврядування', nameEn: 'Student Government' },
  { code: 'SCIENTIFIC_SOCIETY', kind: 'COMMUNITY', nameUk: 'Наукове товариство', nameEn: 'Scientific Society' },
  { code: 'YOUTH_BUSINESS_CENTER', kind: 'COMMUNITY', nameUk: 'Молодіжний бізнес-центр', nameEn: 'Youth Business Center' },
  { code: 'TRADE_UNION', kind: 'COMMUNITY', nameUk: 'Профспілковий комітет', nameEn: 'Trade Union Committee' },
  { code: 'ARTS_CENTER', kind: 'COMMUNITY', nameUk: 'Центр мистецтв і дозвілля', nameEn: 'Arts and Leisure Center' },
  { code: 'MUSEUM', kind: 'COMMUNITY', nameUk: 'Музей університету', nameEn: 'University Museum' },
  // External
  { code: 'EMPLOYERS_ASSOCIATION', kind: 'EXTERNAL', nameUk: 'Асоціація роботодавців', nameEn: 'Employers Association' },
  { code: 'ALUMNI_ASSOCIATION', kind: 'EXTERNAL', nameUk: 'Асоціація випускників', nameEn: 'Alumni Association' },
  {
    code: 'INDUSTRY_RELATIONS',
    kind: 'EXTERNAL',
    nameUk: 'Центр зв’язків з виробництвом',
    nameEn: 'Industry Relations Center',
  },
];

/** Units every college / the lyceum also gets, so trust and safety services exist everywhere. */
export const SATELLITE_ORG_UNITS = ['CIVIL_PROTECTION', 'PSYCHOLOGICAL_SERVICE', 'ADMISSIONS', 'STUDENT_DOCS'];

export const DORMITORY_NUMBERS = [1, 2, 3, 4];
