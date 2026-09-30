import { COMPANY, CompanyInformation, CONTACT_EMAIL, DPO, HELLO_EMAIL, Mail } from './common';

/* /imprint: the legal notice (company information required for an Italian company's website). */
export function Imprint() {
  return (
    <>
      <h2 id="operator">1. Operator</h2>
      <p>
        The website centralcity.ai and the services offered on it are operated within a holding
        structure. The parent company is:
      </p>
      <p>
        <strong>{COMPANY.name}</strong>
        <br />
        {COMPANY.form}
        <br />
        {COMPANY.seat}
      </p>
      <h2 id="contact">2. Contact</h2>
      <p>
        General enquiries: <Mail to={HELLO_EMAIL} /> · Press: <Mail to={CONTACT_EMAIL} />. All
        addresses are listed on our <a href="/contact">Contact</a> page.
      </p>
      <h2 id="data-protection">3. Data protection</h2>
      <p>
        Data Protection Officer: {DPO.name}, <Mail to={DPO.email} />.
      </p>
      <h2 id="policies">4. Legal information</h2>
      <p>
        <a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Policy</a> ·{' '}
        <a href="/acceptable-use">Acceptable Use Policy</a>
      </p>
      <CompanyInformation office />
    </>
  );
}
