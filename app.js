require('dotenv').config();
var fs = require('fs');
var async = require('async');
var request = require('request');
var cheerio = require('cheerio');
var Converter = require('csvtojson').Converter;
var converter = new Converter({});
var sf = require('jsforce');
var nodemailer = require('nodemailer');
var transporter = nodemailer.createTransport(process.env.SMTPACCT);

//var config = { loginUrl:process.env.SF_URL, logLevel: "DEBUG" };
var config = { loginUrl:process.env.SF_URL };
var conn = new sf.Connection(config);
var added = { Account: 0, Contact: 0, Opportunity: 0, Amount: 0 };

// Date format: 25/06/2016
var yesterday = (function(d){d.setDate(d.getDate()-1); return d})(new Date);
var fromDate = ("0" + yesterday.getDate()).slice(-2) + '/' + ("0" + (yesterday.getMonth()+1)).slice(-2) + '/' + yesterday.getFullYear(); // 25/06/2016
var toDate = fromDate;
if (process.argv.length > 3) {
  fromDate = process.argv[2];
  toDate = process.argv[3];
}
else if (process.argv.length > 2) {
  fromDate = toDate = process.argv[2];
}

var reqOptions = [
  { method:"GET",  url:process.env.CH_URL + "/en/SignIn.aspx" },
  { method:"POST", url:process.env.CH_URL + "/en/SignIn.aspx", jar:true, followAllRedirects:true, form:
    { 'ctl00$bodyContentContainer$SignInControl$EmailAddress':process.env.CH_USERNAME,
      'ctl00$bodyContentContainer$SignInControl$Password':process.env.CH_PASSWORD,
      'ctl00$bodyContentContainer$SignInControl$btnSignIn':'Sign In' } },
  { method:"GET",  url:process.env.CH_URL + "/en/Admin/MCDonations_DataDownload.aspx", jar:true },
  { method:"POST", url:process.env.CH_URL + "/en/Admin/MCDonations_DataDownload.aspx", jar:true, form:
    { 'ctl00$bodyContentContainer$txtFromDate':fromDate,
      'ctl00$bodyContentContainer$txtToDate':toDate,
      'ctl00$bodyContentContainer$btnDownloadData.x':20,
      'ctl00$bodyContentContainer$btnDownloadData.y':13 } }
];

var data = "";
var viewstate = "";
var q = async.queue(function (options, callback) {
  if (options.form !== undefined) { options.form['__VIEWSTATE'] = viewstate; }
  request(options, function (err, response, html) {
    if (err || response.statusCode !== 200) { return output(err); }
    var $ = cheerio.load(html);
    if (typeof $('input#__VIEWSTATE')[0] === 'object') { viewstate = $('input#__VIEWSTATE')[0].attribs.value; }
    data = html;
    callback();
  });
});

q.drain = function() { processData(data); }

for (var i in reqOptions) { q.push(reqOptions[i]); }

function processData(data) {
  converter.fromString(data, function(err, results) {
    if (err) { return output(err); }
    conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD + process.env.SF_ACCESS_TOKEN, function(err, user) {
      if (err) { return output(err); }
      var asyncTasks = [];
      results.forEach(function(result) {
        if (result['DONOR COMPANY NAME'] === undefined) { return; }
        var account = { Name:'General' };
        if ((result['DONOR COMPANY NAME'] !== '') && (result['DONOR COMPANY NAME'] !== 'ANON')) {
          account.Name = result['DONOR COMPANY NAME'];
        }

        var contact = {};
        contact.FirstName = capitalizeFirstLetter(result['DONOR FIRST NAME']);
        if (contact.FirstName === '') { contact.FirstName = 'ANON'; }
        contact.LastName = capitalizeFirstLetter(result['DONOR LAST NAME']);
        if (contact.LastName === '') { contact.LastName = 'ANON'; }
        contact.Email = result['DONOR EMAIL ADDRESS'];
        if (contact.Email === '') { contact.Email = 'ANON'; }
        if (contact.Email.indexOf("@") === -1) { contact.Email += '@ANON.COM'; }
        contact.Email = contact.Email.toLowerCase();
        //contact.Account = ""; // Lookup(Account)
        contact.MailingStreet = result['DONOR ADDRESS 1'] + '\n' + result['DONOR ADDRESS 2'];
        contact.MailingCity = result['DONOR CITY'];
        contact.MailingState = result['DONOR PROVINCE/STATE'];
        contact.MailingPostalCode = result['DONOR POSTAL/ZIP CODE'];
        contact.MailingCountry = result['DONOR COUNTRY'];

        var opportunity = {};
        opportunity.Name = result['TRANSACTION NUMBER'];
        //opportunity.Donor_Name__c = ""; // Lookup(Contact)
        opportunity.StageName = 'Closed Won';
        opportunity.canh__Payment_Method__c = result['PAYMENT METHOD'];
        opportunity.Amount = result['AMOUNT'];
        opportunity.CloseDate = result['DONATION DATE'];
        opportunity.Receive_Date__c = result['DONATION DATE'];
        opportunity.canh__Fee__c = result['FEE'];
        opportunity.canh__In_Honour__c = result['IN HONOUR OF'];
        opportunity.canh__In_Memory__c = result['IN MEMORY OF'];
        opportunity.canh__Honouree__c = result['HONOUREE'];
        opportunity.Description = result['MESSAGE TO CHARITY'];
        opportunity.canh__Donation_Source__c = result['DONATION SOURCE'];

        if (process.env.OPT_DEBUG > 1) {
          console.log("-----------------------");
          console.log(account);
          console.log(contact);
          console.log(opportunity);
        }

        asyncTasks.push(function(callback) { createData("Account", "Name", account, callback, contact, "AccountId"); });
        asyncTasks.push(function(callback) { createData("Contact", "Email", contact, callback, opportunity, "Donor_Name__c"); });
        asyncTasks.push(function(callback) { createData("Opportunity", "Name", opportunity, callback, null, null); });
      });
      async.series(asyncTasks, function(){
        var text = "Amount:        $" + added.Amount + "\n" +
                   "Opportunities: " + added.Opportunity + "\n" +
                   "Contacts:      " + added.Contact + "\n" +
                   "Accounts:      " + added.Account;
        output(text);
      });
    });
  });
}

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function createData(table, unique, data, callback, idObj, idAttribute) {
  if (process.env.OPT_DEBUG > 0) { console.log(data[unique]); }
  conn.query("SELECT Id FROM " + table + " WHERE " + unique + " = '" + data[unique] + "'", function(err, result) {
    if (err) { callback(); return output(err); }
    if (result.totalSize > 0) {
      if (idObj !== null) { idObj[idAttribute] = result.records[0].Id; }
      callback();
      return;
    }
    if (process.env.OPT_CREATE === 'false') { callback(); return; }
    conn.sobject(table).create(data, function(err, ret) {
      if (err || !ret.success) { callback(); return output(err); }
      if (idObj !== null) { idObj[idAttribute] = ret.id; }
      added[table]++;
      if (table === 'Opportunity') { added.Amount += parseFloat(data.Amount); }
      if (process.env.OPT_DEBUG > 0) { console.log("Created " + table + " record id : " + ret.id); }
      callback();
    });
  });
}

function output(text) {
  var report = "<pre>\n" + text + "\n" +
               "Import dates:  " + fromDate + " - " + toDate + "\n" + "</pre>";
  var mailOptions = {
    from: process.env.REPORTFROM,
    to: process.env.REPORTTO,
    subject: process.env.REPORTSUBJECT,
    text: report,
    html: report
  };
  if (process.env.OPT_EMAIL === 'true') {
    transporter.sendMail(mailOptions, function(err, info) { if (err) { console.log(err); } });
  }
  else {
    console.log(report);
  }
}
