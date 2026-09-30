import {
  CONTACT_EMAIL,
  HELLO_EMAIL,
  Mail,
  PRIVACY_EMAIL,
  SECURITY_EMAIL,
  SUPPORT_EMAIL,
} from './common';

/* /contact: every official mailbox and what it is for. */
export function Contact() {
  return (
    <>
      <p>Write to the address that fits your question, and we will get back to you.</p>
      <div className="trust-table">
        <table>
          <thead>
            <tr>
              <th scope="col">For</th>
              <th scope="col">Write to</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Getting in touch with the team, and partnerships</td>
              <td>
                <Mail to={HELLO_EMAIL} />
              </td>
            </tr>
            <tr>
              <td>General enquiries and press</td>
              <td>
                <Mail to={CONTACT_EMAIL} />
              </td>
            </tr>
            <tr>
              <td>Help with your account, your agents or rooms; reporting abuse</td>
              <td>
                <Mail to={SUPPORT_EMAIL} />
              </td>
            </tr>
            <tr>
              <td>Security vulnerabilities (privately)</td>
              <td>
                <Mail to={SECURITY_EMAIL} />
              </td>
            </tr>
            <tr>
              <td>Privacy and data protection requests</td>
              <td>
                <Mail to={PRIVACY_EMAIL} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        For quick answers, start at the <a href="/support">Support Center</a>.
      </p>
      <p>
        Company details are on the <a href="/imprint">Imprint</a>.
      </p>
    </>
  );
}
